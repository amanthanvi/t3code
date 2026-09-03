/**
 * Settles a thread's still-running background agent tasks from the persisted
 * activity rows, without the provider's cooperation.
 *
 * Native multi-agent children (Codex collab, workflow members) only leave the
 * live set when the provider keeps reporting them. Compaction, a provider
 * restart, a host Stop for a child the provider has already forgotten, or a
 * T3 restart all lose that reporting, and the last persisted row stays
 * "running" forever — the Agents panel and the composer's "N agents working"
 * banner never clear.
 *
 * Persisted rows are the authority here: at the three moments where the server
 * knows background work cannot continue (session death, host Stop, startup
 * reconciliation) it folds the thread's task rows, synthesizes one terminal
 * `task.updated` per still-live agent task, and feeds the same transition to
 * the in-memory liveness registry so rows and registry settle together.
 *
 * @module ThreadTaskSettlement
 */
import {
  CommandId,
  EventId,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";

/**
 * Fleet size worth a log line. There is no cap on settlement: leaving even one
 * live task behind means Stop is visibly incomplete, because the client ranks
 * live agents first inside its own roster cap and would keep showing it.
 */
const LARGE_SETTLEMENT_LOG_THRESHOLD = 100;

/** The fold reads nothing but the kind and the payload of a row. */
export interface TaskActivityRow {
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * Linkage the synthesized terminal row carries forward so it stays a
 * self-describing agent row: `agentKind` keeps it on the Agents surface and
 * the rest keep the card's identity when the start row ages out.
 */
const LINKAGE_FIELDS = [
  "agentKind",
  "title",
  "role",
  "agentPath",
  "timelineBypass",
  "model",
  "effort",
] as const;

// Collapsed mirror of the client fold (subagentRuntime.foldSubagentActivities):
// only "is this task still live" matters here, so every terminal status folds
// into one state.
type FoldStatus = "pending" | "running" | "waiting" | "idle" | "terminal";

const LIVE_STATUSES: ReadonlySet<FoldStatus> = new Set<FoldStatus>([
  "pending",
  "running",
  "waiting",
]);

// RuntimeTaskStatus, collapsed. `task.completed` carries its own outcome and
// is terminal whatever it says, so its status values are not listed here.
const KNOWN_STATUSES: ReadonlyMap<string, FoldStatus> = new Map<string, FoldStatus>([
  ["pending", "pending"],
  ["running", "running"],
  ["waiting", "waiting"],
  ["idle", "idle"],
  ["completed", "terminal"],
  ["failed", "terminal"],
  ["cancelled", "terminal"],
  ["interrupted", "terminal"],
]);

interface FoldEntry {
  readonly taskId: string;
  status: FoldStatus;
  /** Latest row's payload, used to copy linkage onto the synthesized row. */
  payload: Record<string, unknown>;
  /** A workflow coordinator, whose settling ends its members' run. */
  isWorkflow: boolean;
  /** The coordinator this task belongs to, if any. */
  parentAgentId: string | undefined;
}

export interface LiveAgentTask {
  readonly taskId: string;
  readonly linkage: Record<string, unknown>;
}

function asPayload(activity: TaskActivityRow): Record<string, unknown> | undefined {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : undefined;
}

/** The client fold's `asString`: trimmed, or absent when empty. */
function asTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Identity the workflow cascade needs, filled from every row and never
 * downgraded — the client fold's getOrCreate/fillMetadata rules, narrowed to
 * the two fields that decide whether a coordinator owns a task.
 */
function fillIdentity(entry: FoldEntry, payload: Record<string, unknown>): void {
  if (asTrimmed(payload.taskType) === "local_workflow") {
    entry.isWorkflow = true;
  }
  const parentAgentId = asTrimmed(payload.parentAgentId);
  if (parentAgentId !== undefined) {
    entry.parentAgentId = parentAgentId;
  }
}

function newEntry(taskId: string, payload: Record<string, unknown>, status: FoldStatus): FoldEntry {
  return { taskId, status, payload, isWorkflow: false, parentAgentId: undefined };
}

/** Rows without the server-stamped agent classification are background work. */
function isAgentRow(payload: Record<string, unknown>): boolean {
  return payload.agentKind === "agent";
}

function asFoldStatus(value: unknown): FoldStatus | undefined {
  return typeof value === "string" ? KNOWN_STATUSES.get(value) : undefined;
}

/** Terminal is sticky: a duplicate or late terminal row never slides state. */
function applyStatus(entry: FoldEntry, next: FoldStatus): void {
  if (entry.status === "terminal" && next === "terminal") {
    return;
  }
  entry.status = next;
}

/**
 * Folds a thread's persisted task activities into the set of agent tasks that
 * are still live, newest linkage attached. Pure and tolerant: malformed rows
 * are skipped individually.
 *
 * Membership is decided once, by the first row for a task id: terminal rows
 * often carry only the id and a status, so re-judging them would drop agents
 * mid-fold. A late `task.started` after a terminal row is an out-of-order
 * delivery and does not reopen the run. A settled workflow coordinator ends
 * its members' run, exactly as the client fold has it.
 */
export function selectLiveAgentTasks(
  activities: ReadonlyArray<TaskActivityRow>,
): ReadonlyArray<LiveAgentTask> {
  const entries = new Map<string, FoldEntry>();

  for (const activity of activities) {
    const payload = asPayload(activity);
    if (!payload) {
      continue;
    }
    const taskId = asTrimmed(payload.taskId);
    if (!taskId) {
      continue;
    }
    const existing = entries.get(taskId);
    if (!existing && !isAgentRow(payload)) {
      continue;
    }

    switch (activity.kind) {
      case "task.started": {
        // A start row is judged on its own stamp every time: it is the row
        // that puts an agent on the roster.
        if (!isAgentRow(payload)) {
          break;
        }
        const entry = existing ?? newEntry(taskId, payload, "running");
        if (existing !== undefined && existing.status === "idle") {
          entry.status = "running";
        }
        entry.payload = payload;
        fillIdentity(entry, payload);
        entries.set(taskId, entry);
        break;
      }
      case "task.progress": {
        const entry = existing ?? newEntry(taskId, payload, "running");
        const status = asFoldStatus(payload.status);
        if (status !== undefined) {
          applyStatus(entry, status);
        } else if (
          // A usage-only tick must not restart a task that is already known.
          // As the FIRST row for a task it does start it: the client fold
          // does the same, so a child whose start row aged out of retention
          // still reads as live on both sides instead of only one.
          (payload.usageSnapshot !== true || existing === undefined) &&
          entry.status !== "terminal" &&
          entry.status !== "idle"
        ) {
          entry.status = "running";
        }
        entry.payload = payload;
        fillIdentity(entry, payload);
        entries.set(taskId, entry);
        break;
      }
      case "task.updated": {
        const entry = existing ?? newEntry(taskId, payload, "running");
        const status = asFoldStatus(payload.status);
        if (status !== undefined) {
          applyStatus(entry, status);
        }
        entry.payload = payload;
        fillIdentity(entry, payload);
        entries.set(taskId, entry);
        break;
      }
      case "task.completed": {
        const entry = existing ?? newEntry(taskId, payload, "terminal");
        applyStatus(entry, "terminal");
        entry.payload = payload;
        fillIdentity(entry, payload);
        entries.set(taskId, entry);
        break;
      }
      default:
        break;
    }
  }

  // Consistency pass, mirroring the client fold: once a workflow coordinator
  // has settled, members without a terminal row of their own cannot still be
  // in flight — the run is over. The client shows them with the coordinator's
  // outcome, so settling them here would overwrite a completed run with
  // "interrupted".
  for (const coordinator of entries.values()) {
    if (!coordinator.isWorkflow || coordinator.status !== "terminal") {
      continue;
    }
    for (const member of entries.values()) {
      if (member.parentAgentId !== coordinator.taskId) {
        continue;
      }
      if (member.status === "terminal" || member.status === "idle") {
        continue;
      }
      member.status = "terminal";
    }
  }

  const live: LiveAgentTask[] = [];
  for (const [taskId, entry] of entries) {
    if (!LIVE_STATUSES.has(entry.status)) {
      continue;
    }
    const linkage: Record<string, unknown> = {};
    for (const field of LINKAGE_FIELDS) {
      if (entry.payload[field] !== undefined) {
        linkage[field] = entry.payload[field];
      }
    }
    live.push({ taskId, linkage });
  }
  return live;
}

/**
 * Stable per-task id so repeated settlement (Stop, then the session exiting)
 * replaces the same row instead of piling up duplicates.
 */
export function settledTaskActivityId(threadId: ThreadId, taskId: string): EventId {
  return EventId.make(`task-settled:${threadId}:${taskId}`);
}

/**
 * Marks every still-live agent task on the thread as settled: one persisted
 * terminal `task.updated` per task, plus the matching liveness transition.
 *
 * Never fails the caller — Stop, session teardown, and startup all continue
 * when settlement cannot read or write.
 */
export const settleThreadTasks = Effect.fn("settleThreadTasks")(function* (input: {
  readonly threadId: ThreadId;
  readonly status: "interrupted";
  readonly createdAt: string;
}) {
  const activityRepository = yield* ProjectionThreadActivityRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;

  const settle = Effect.gen(function* () {
    // Complete task history, not the thread detail read's newest-N window:
    // that window is shared with every other activity kind, so a busy thread
    // could hide a live task's rows and then resurrect it as a settled card.
    const rows = yield* activityRepository.listTaskLifecycleByThreadId({
      threadId: input.threadId,
    });
    const liveTasks = selectLiveAgentTasks(rows);
    if (liveTasks.length > LARGE_SETTLEMENT_LOG_THRESHOLD) {
      yield* Effect.logInfo("settling a large background task fleet", {
        threadId: input.threadId,
        liveTaskCount: liveTasks.length,
      });
    }
    for (const task of liveTasks) {
      const activity: OrchestrationThreadActivity = {
        id: settledTaskActivityId(input.threadId, task.taskId),
        createdAt: input.createdAt,
        tone: "info",
        kind: "task.updated",
        summary: "Task interrupted",
        payload: {
          taskId: task.taskId,
          status: input.status,
          endedAt: input.createdAt,
          ...task.linkage,
        },
        turnId: null,
      };
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`task-settle:${yield* crypto.randomUUIDv4}`),
        threadId: input.threadId,
        activity,
        createdAt: input.createdAt,
      });
      // Rows and registry settle together, so the sidebar pill and the
      // composer banner can never disagree about the same task.
      threadBackgroundLiveness.recordTaskLiveness({
        threadId: input.threadId,
        taskId: task.taskId,
        taskType: undefined,
        status: input.status,
        kind: "updated",
        settledByHost: true,
      });
    }
  });

  yield* settle.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("failed to settle thread background tasks", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
    ),
  );
});
