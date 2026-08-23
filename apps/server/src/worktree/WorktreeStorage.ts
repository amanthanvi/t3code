import {
  CommandId,
  ThreadId,
  WORKTREE_STORAGE_MAX_ASSOCIATED_THREAD_IDS,
  WORKTREE_STORAGE_MAX_DETAILS,
  WORKTREE_STORAGE_MAX_ERRORS,
  WORKTREE_STORAGE_MAX_OUTCOMES,
  WORKTREE_STORAGE_MAX_PROJECTS,
  WorktreeStorageError,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  type WorktreeAutoPrunePolicy,
  type WorktreeStorageDetail,
  type WorktreeStorageProjectAggregate,
  type WorktreeStorageProtectionReason,
  type WorktreeStoragePruneOutcome,
  type WorktreeStoragePruneResult,
  type WorktreeStorageReport,
  type WorktreeStorageScanError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import {
  discoverWorktreeDirectoriesNoFollowPromise,
  measureDirectoryNoFollowPromise,
} from "./directorySize.ts";

const SIZE_SCAN_CONCURRENCY = 4;
const MAX_CANDIDATES_PER_SCAN = 200;
const SIZE_SCAN_MAX_ENTRIES = 250_000;
const SIZE_SCAN_MAX_DURATION_MS = 15_000;
const AUTO_SWEEP_INTERVAL = Duration.hours(6);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT_BYTES = 1_000_000;

export type ScanMode =
  | { readonly mode: "manual" }
  | { readonly mode: "inactive"; cutoffMs: number };

interface CandidateAssociation {
  readonly key: string;
  readonly worktreePath: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}

interface ScanContext {
  readonly associations: ReadonlyArray<CandidateAssociation>;
  readonly threadsById: ReadonlyMap<string, OrchestrationThreadShell>;
  readonly liveProviderThreadIds: ReadonlySet<string>;
  readonly liveProviderPaths: ReadonlyArray<string>;
  readonly liveTerminalThreadIds: ReadonlySet<string>;
  readonly liveTerminalPaths: ReadonlyArray<string>;
  readonly inventoryErrors: ReadonlyArray<WorktreeStorageScanError>;
}

interface InternalCandidateScan {
  readonly key: string;
  readonly association: CandidateAssociation;
  readonly detail: WorktreeStorageDetail;
  readonly mainWorktreePath: string | null;
  readonly removalPath: string | null;
}

interface WorktreePorcelainEntry {
  readonly path: string;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly detached: boolean;
}

interface CandidateScanBatch {
  readonly scans: ReadonlyArray<InternalCandidateScan>;
  readonly omittedCandidateCount: number;
  readonly inventoryErrors: ReadonlyArray<WorktreeStorageScanError>;
}

interface ReservedThreadPath {
  readonly thread: OrchestrationThreadShell;
  readonly restoreCommandId: CommandId;
}

interface ThreadPathReservation {
  readonly threads: ReadonlyArray<ReservedThreadPath>;
  readonly errors: ReadonlyArray<WorktreeStorageScanError>;
}

interface DirectorySizeResult {
  readonly bytes: number;
  readonly errors: ReadonlyArray<WorktreeStorageScanError>;
}

interface GitInspectionResult {
  readonly reasons: ReadonlyArray<WorktreeStorageProtectionReason>;
  readonly errors: ReadonlyArray<WorktreeStorageScanError>;
  readonly mainWorktreePath: string | null;
  readonly targetWorktreePath: string | null;
}

function boundedMessage(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : String(cause);
  const trimmed = value.trim();
  return (trimmed.length === 0 ? "Unknown inspection failure." : trimmed).slice(0, 1_024);
}

function scanError(operation: string, cause: unknown, path?: string): WorktreeStorageScanError {
  return {
    operation: operation.slice(0, 128) || "inspect",
    message: boundedMessage(cause),
    ...(path === undefined ? {} : { path: path.slice(0, 4_096) }),
  };
}

function safeByteCount(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

export function isCanonicallyContained(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isSameOrDescendant(path: Path.Path, parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function hasLivePathUse(
  path: Path.Path,
  candidatePath: string,
  livePaths: ReadonlyArray<string>,
): boolean {
  return livePaths.some((livePath) => isSameOrDescendant(path, candidatePath, livePath));
}

export function parseWorktreePorcelain(output: string): ReadonlyArray<WorktreePorcelainEntry> {
  const entries: WorktreePorcelainEntry[] = [];
  let current: { path?: string; locked: boolean; prunable: boolean; detached: boolean } = {
    locked: false,
    prunable: false,
    detached: false,
  };
  const flush = () => {
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        locked: current.locked,
        prunable: current.prunable,
        detached: current.detached,
      });
    }
    current = { locked: false, prunable: false, detached: false };
  };

  for (const field of output.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      current.path = field.slice("worktree ".length);
    } else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true;
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
    } else if (field === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

export function decodeWorktreePorcelain(
  output: string,
): { readonly entries: ReadonlyArray<WorktreePorcelainEntry> } | { readonly error: string } {
  if (output.length === 0 || !output.endsWith("\0\0")) {
    return { error: "Git worktree porcelain output was empty or unterminated." };
  }
  const records = output.slice(0, -2).split("\0\0");
  const entries: WorktreePorcelainEntry[] = [];
  for (const record of records) {
    const fields = record.split("\0");
    const worktreeFields = fields.filter((field) => field.startsWith("worktree "));
    const headFields = fields.filter((field) => field.startsWith("HEAD "));
    const branchFields = fields.filter((field) => field.startsWith("branch "));
    const detachedFields = fields.filter((field) => field === "detached");
    const worktreeField = worktreeFields[0];
    const headField = headFields[0];
    if (
      fields[0]?.startsWith("worktree ") !== true ||
      worktreeFields.length !== 1 ||
      worktreeField === undefined ||
      worktreeField.slice("worktree ".length).length === 0 ||
      headFields.length !== 1 ||
      headField === undefined ||
      headField.slice("HEAD ".length).length === 0 ||
      branchFields.length + detachedFields.length !== 1
    ) {
      return { error: "Git worktree porcelain output contained a malformed record." };
    }
    entries.push({
      path: worktreeField.slice("worktree ".length),
      locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
      prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
      detached: detachedFields.length === 1,
    });
  }
  return entries.length === 0
    ? { error: "Git worktree porcelain output contained no records." }
    : { entries };
}

export function worktreeListOutputError(output: {
  readonly stdoutTruncated: boolean;
  readonly stdoutInvalidUtf8?: boolean;
}): string | null {
  if (output.stdoutTruncated) {
    return "Git worktree porcelain output exceeded the safety limit.";
  }
  if (output.stdoutInvalidUtf8 === true) {
    return "Git worktree porcelain output was not valid UTF-8.";
  }
  return null;
}

export function isAppliedThreadPathEvent(input: {
  readonly event: OrchestrationEvent;
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
}): boolean {
  return (
    input.event.sequence === input.sequence &&
    input.event.type === "thread.meta-updated" &&
    input.event.payload.threadId === input.threadId &&
    Object.prototype.hasOwnProperty.call(input.event.payload, "worktreePath") &&
    input.event.payload.worktreePath === input.worktreePath
  );
}

export function withReservationRestoration<A, E, R, R2>(
  use: Effect.Effect<{ readonly value: A; readonly physicalRemovalSucceeded: boolean }, E, R>,
  restore: Effect.Effect<void, never, R2>,
): Effect.Effect<A, E, R | R2> {
  return use.pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) && exit.value.physicalRemovalSucceeded ? Effect.void : restore,
    ),
    Effect.map(({ value }) => value),
  );
}

export const measureDirectoryNoFollow = Effect.fn("WorktreeStorage.measureDirectoryNoFollow")(
  function* (rootPath: string): Effect.fn.Return<DirectorySizeResult> {
    const result = yield* Effect.promise(() =>
      measureDirectoryNoFollowPromise(rootPath, {
        maxEntries: SIZE_SCAN_MAX_ENTRIES,
        maxDurationMs: SIZE_SCAN_MAX_DURATION_MS,
        maxFailures: WORKTREE_STORAGE_MAX_ERRORS,
      }),
    );
    return {
      bytes: safeByteCount(result.bytes),
      errors: result.failures.map((failure) =>
        scanError(failure.operation, failure.cause, failure.path),
      ),
    };
  },
);

function latestDurableActivity(thread: OrchestrationThreadShell): {
  readonly value: string | null;
  readonly epochMs: number | null;
  readonly unknown: boolean;
} {
  const values = [
    thread.createdAt,
    thread.updatedAt,
    thread.archivedAt,
    thread.settledAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
    thread.session?.updatedAt,
  ].filter((value): value is string => value !== null && value !== undefined);
  let latestValue: string | null = null;
  let latestEpochMs: number | null = null;
  for (const value of values) {
    const parsed = DateTime.make(value);
    if (Option.isNone(parsed)) return { value: null, epochMs: null, unknown: true };
    const epochMs = DateTime.toEpochMillis(parsed.value);
    if (latestEpochMs === null || epochMs > latestEpochMs) {
      latestValue = value;
      latestEpochMs = epochMs;
    }
  }
  return { value: latestValue, epochMs: latestEpochMs, unknown: latestEpochMs === null };
}

function addReason(
  reasons: Set<WorktreeStorageProtectionReason>,
  condition: boolean,
  reason: WorktreeStorageProtectionReason,
): void {
  if (condition) reasons.add(reason);
}

export function threadReasons(
  thread: OrchestrationThreadShell,
  mode: ScanMode,
  liveProviderThreadIds: ReadonlySet<string>,
  liveTerminalThreadIds: ReadonlySet<string>,
): ReadonlyArray<WorktreeStorageProtectionReason> {
  const reasons = new Set<WorktreeStorageProtectionReason>();
  const activity = latestDurableActivity(thread);
  if (mode.mode === "manual") {
    addReason(reasons, thread.archivedAt === null && thread.settledAt === null, "unsettled-thread");
  } else {
    addReason(
      reasons,
      activity.unknown || activity.epochMs === null || activity.epochMs >= mode.cutoffMs,
      activity.unknown ? "inspection-error" : "recent-activity",
    );
  }

  addReason(reasons, thread.latestTurn?.state === "running", "active-turn-or-session");
  addReason(
    reasons,
    thread.session !== null &&
      (thread.session.activeTurnId !== null ||
        thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.status === "ready"),
    "active-turn-or-session",
  );
  addReason(reasons, thread.hasPendingApprovals, "pending-approval");
  addReason(reasons, thread.hasPendingUserInput, "pending-input");
  addReason(
    reasons,
    thread.hasActionableProposedPlan || thread.planProgress != null,
    "pending-plan",
  );
  addReason(reasons, thread.backgroundLiveness != null, "background-liveness");
  addReason(reasons, liveProviderThreadIds.has(thread.id), "live-provider");
  addReason(reasons, liveTerminalThreadIds.has(thread.id), "live-terminal");
  return [...reasons].sort();
}

export function associationReasons(input: {
  readonly projectCount: number;
  readonly hasLiveTerminalPath: boolean;
}): ReadonlyArray<WorktreeStorageProtectionReason> {
  const reasons: WorktreeStorageProtectionReason[] = [];
  if (input.projectCount > 1) reasons.push("shared-across-projects");
  if (input.hasLiveTerminalPath) reasons.push("live-terminal");
  return reasons;
}

export function rankProjects(
  projects: ReadonlyArray<WorktreeStorageProjectAggregate>,
): ReadonlyArray<WorktreeStorageProjectAggregate> {
  return [...projects].sort(
    (left, right) => right.bytes - left.bytes || left.projectId.localeCompare(right.projectId),
  );
}

export function rankDetails(
  details: ReadonlyArray<WorktreeStorageDetail>,
): ReadonlyArray<WorktreeStorageDetail> {
  return [...details].sort(
    (left, right) =>
      right.bytes - left.bytes || left.worktreePath.localeCompare(right.worktreePath),
  );
}

export function worktreeRemovalArgs(worktreePath: string): ReadonlyArray<string> {
  return ["worktree", "remove", worktreePath];
}

export function shouldRestoreReservedPaths(removalSucceeded: boolean): boolean {
  return !removalSucceeded;
}

export function reservationIsValid(input: {
  readonly candidateStillRegistered: boolean;
  readonly associationThreadCount: number;
  readonly expectedThreadCount: number;
  readonly currentThreadPaths: ReadonlyArray<string | null>;
  readonly becameLive: boolean;
}): boolean {
  return (
    input.candidateStillRegistered &&
    input.associationThreadCount === 0 &&
    input.currentThreadPaths.length === input.expectedThreadCount &&
    input.currentThreadPaths.every((worktreePath) => worktreePath === null) &&
    !input.becameLive
  );
}

export function automaticScanMode(policy: WorktreeAutoPrunePolicy, nowMs: number): ScanMode | null {
  switch (policy.mode) {
    case "off":
      return null;
    case "on-settle":
      return { mode: "manual" };
    case "after-inactive-days":
      return {
        mode: "inactive",
        cutoffMs: nowMs - Duration.toMillis(Duration.days(policy.inactivityDays)),
      };
  }
}

export function automaticPolicyKey(policy: WorktreeAutoPrunePolicy): string {
  return policy.mode === "after-inactive-days"
    ? `${policy.mode}:${policy.inactivityDays}`
    : policy.mode;
}

export function shouldRunAutomaticFallback(policy: WorktreeAutoPrunePolicy): boolean {
  return policy.mode === "after-inactive-days";
}

export function shouldProtectOrphan(threadCount: number): boolean {
  return threadCount === 0;
}

export function selectCandidateWindow<A>(
  candidates: ReadonlyArray<A>,
  startIndex: number,
  limit = MAX_CANDIDATES_PER_SCAN,
): { readonly selected: ReadonlyArray<A>; readonly omittedCandidateCount: number } {
  const normalizedStart = candidates.length === 0 ? 0 : startIndex % candidates.length;
  const ordered = [...candidates.slice(normalizedStart), ...candidates.slice(0, normalizedStart)];
  const selected = ordered.slice(0, limit);
  return {
    selected,
    omittedCandidateCount: Math.max(0, ordered.length - selected.length),
  };
}

function aggregateLatestActivity(threads: ReadonlyArray<OrchestrationThreadShell>): string | null {
  let latest: { value: string; epochMs: number } | null = null;
  for (const thread of threads) {
    const activity = latestDurableActivity(thread);
    if (activity.value === null || activity.epochMs === null) continue;
    if (latest === null || activity.epochMs > latest.epochMs) {
      latest = { value: activity.value, epochMs: activity.epochMs };
    }
  }
  return latest?.value ?? null;
}

export interface WorktreeStorageService {
  readonly getReport: Effect.Effect<WorktreeStorageReport, WorktreeStorageError>;
  readonly pruneStale: Effect.Effect<WorktreeStoragePruneResult, WorktreeStorageError>;
}

const unavailable = (operation: "report" | "prune") =>
  Effect.fail(
    new WorktreeStorageError({
      operation,
      message: "Worktree storage is not available on this environment.",
    }),
  );

/** Defaulting keeps older test/server layer compositions version-skew safe. */
export class WorktreeStorage extends Context.Reference<WorktreeStorageService>(
  "t3/worktree/WorktreeStorage",
  {
    defaultValue: () => ({
      getReport: unavailable("report"),
      pruneStale: unavailable("prune"),
    }),
  },
) {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providers = yield* ProviderService.ProviderService;
  const terminals = yield* TerminalManager.TerminalManager;
  const settings = yield* ServerSettings.ServerSettingsService;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const crypto = yield* Crypto.Crypto;
  const pruneLock = yield* Semaphore.make(1);
  const pruneCursor = yield* Ref.make(0);

  const runGit = (cwd: string, args: ReadonlyArray<string>) =>
    vcsProcess.run({
      operation: "worktree-storage",
      command: "git",
      args,
      cwd,
      allowNonZeroExit: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });

  const inspectGitCandidate = Effect.fn("WorktreeStorage.inspectGitCandidate")(function* (
    candidatePath: string,
  ): Effect.fn.Return<GitInspectionResult> {
    const reasons = new Set<WorktreeStorageProtectionReason>();
    const errors: WorktreeStorageScanError[] = [];
    const listResult = yield* Effect.result(
      runGit(candidatePath, ["worktree", "list", "--porcelain", "-z"]),
    );
    if (Result.isFailure(listResult) || listResult.success.exitCode !== 0) {
      const cause = Result.isFailure(listResult)
        ? listResult.failure
        : listResult.success.stderr || `git exited ${listResult.success.exitCode}`;
      return {
        reasons: ["inspection-error"],
        errors: [scanError("git-worktree-list", cause, candidatePath)],
        mainWorktreePath: null,
        targetWorktreePath: null,
      };
    }

    const unsafeOutput = worktreeListOutputError(listResult.success);
    if (unsafeOutput !== null) {
      return {
        reasons: ["inspection-error"],
        errors: [scanError("git-worktree-list", unsafeOutput, candidatePath)],
        mainWorktreePath: null,
        targetWorktreePath: null,
      };
    }
    const decodedEntries = decodeWorktreePorcelain(listResult.success.stdout);
    if ("error" in decodedEntries) {
      return {
        reasons: ["inspection-error"],
        errors: [scanError("git-worktree-list", decodedEntries.error, candidatePath)],
        mainWorktreePath: null,
        targetWorktreePath: null,
      };
    }
    const entries = decodedEntries.entries;
    const canonicalEntries = yield* Effect.forEach(
      entries,
      (entry) =>
        fileSystem.realPath(entry.path).pipe(
          Effect.orElseSucceed(() => path.resolve(entry.path)),
          Effect.map((canonicalPath) => ({
            ...entry,
            originalPath: entry.path,
            path: canonicalPath,
          })),
        ),
      { concurrency: 4 },
    );
    const mainWorktreePath = canonicalEntries[0]?.path ?? null;
    const target = canonicalEntries.find((entry) => entry.path === candidatePath);
    const targetWorktreePath = target?.originalPath ?? null;
    addReason(reasons, target === undefined, "locked-or-unknown");
    addReason(reasons, mainWorktreePath === candidatePath, "main-checkout");
    addReason(
      reasons,
      target?.locked === true || target?.prunable === true || target?.detached === true,
      "locked-or-unknown",
    );
    if (reasons.size > 0) {
      return { reasons: [...reasons].sort(), errors, mainWorktreePath, targetWorktreePath };
    }

    const statusResult = yield* Effect.result(
      runGit(candidatePath, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    );
    if (Result.isFailure(statusResult) || statusResult.success.exitCode !== 0) {
      const cause = Result.isFailure(statusResult)
        ? statusResult.failure
        : statusResult.success.stderr || `git exited ${statusResult.success.exitCode}`;
      reasons.add("inspection-error");
      errors.push(scanError("git-status", cause, candidatePath));
    } else if (statusResult.success.stdout.trim().length > 0) {
      reasons.add("dirty-or-untracked");
    }

    const upstreamResult = yield* Effect.result(
      runGit(candidatePath, ["rev-parse", "--verify", "@{upstream}"]),
    );
    if (Result.isFailure(upstreamResult)) {
      reasons.add("inspection-error");
      errors.push(scanError("git-upstream", upstreamResult.failure, candidatePath));
    } else if (upstreamResult.success.exitCode === 0) {
      const aheadResult = yield* Effect.result(
        runGit(candidatePath, ["rev-list", "--count", "@{upstream}..HEAD"]),
      );
      if (Result.isFailure(aheadResult) || aheadResult.success.exitCode !== 0) {
        reasons.add("inspection-error");
        errors.push(
          scanError(
            "git-ahead",
            Result.isFailure(aheadResult)
              ? aheadResult.failure
              : aheadResult.success.stderr || `git exited ${aheadResult.success.exitCode}`,
            candidatePath,
          ),
        );
      } else if (Number.parseInt(aheadResult.success.stdout.trim(), 10) > 0) {
        reasons.add("ahead-or-unpushed");
      }
    } else {
      const remoteContainsResult = yield* Effect.result(
        runGit(candidatePath, ["branch", "-r", "--contains", "HEAD", "--format=%(refname)"]),
      );
      if (
        Result.isFailure(remoteContainsResult) ||
        remoteContainsResult.success.exitCode !== 0 ||
        remoteContainsResult.success.stdout.trim().length === 0
      ) {
        reasons.add("ahead-or-unpushed");
        if (Result.isFailure(remoteContainsResult)) {
          errors.push(
            scanError("git-remote-contains", remoteContainsResult.failure, candidatePath),
          );
        }
      }
    }

    return { reasons: [...reasons].sort(), errors, mainWorktreePath, targetWorktreePath };
  });

  const loadScanContext = Effect.fn("WorktreeStorage.loadScanContext")(
    function* (): Effect.fn.Return<ScanContext, WorktreeStorageError> {
      const snapshots = yield* Effect.all({
        active: projection.getShellSnapshot(),
        archived: projection.getArchivedShellSnapshot(),
        providerSessions: providers.listSessions(),
        terminalSummaries:
          terminals.listSummaries ?? Effect.fail("Terminal summary inspection is unavailable."),
        inventory: Effect.promise(() =>
          discoverWorktreeDirectoriesNoFollowPromise(config.worktreesDir, {
            maxEntries: 10_000,
            maxDurationMs: 5_000,
            maxFailures: WORKTREE_STORAGE_MAX_ERRORS,
          }),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new WorktreeStorageError({
              operation: "report",
              message: "Failed to load current thread state for worktree inspection.",
              cause,
            }),
        ),
      );
      const projectsById = new Map(
        [...snapshots.active.projects, ...snapshots.archived.projects].map(
          (project) => [project.id, project] as const,
        ),
      );
      const associations = new Map<
        string,
        {
          worktreePath: string;
          projects: Map<ProjectId, OrchestrationProjectShell>;
          threads: OrchestrationThreadShell[];
        }
      >();
      const referencedThreads = yield* Effect.forEach(
        [...snapshots.active.threads, ...snapshots.archived.threads],
        (thread) =>
          thread.worktreePath === null
            ? Effect.succeed(null)
            : fileSystem.realPath(thread.worktreePath).pipe(
                Effect.orElseSucceed(() => path.resolve(thread.worktreePath!)),
                Effect.map((key) => ({ key, thread, worktreePath: thread.worktreePath! })),
              ),
        { concurrency: SIZE_SCAN_CONCURRENCY },
      );
      for (const referenced of referencedThreads) {
        if (referenced === null) continue;
        const { key, thread, worktreePath } = referenced;
        const project = projectsById.get(thread.projectId);
        const existing = associations.get(key);
        if (existing === undefined) {
          associations.set(key, {
            worktreePath,
            projects: new Map(project === undefined ? [] : ([[project.id, project]] as const)),
            threads: [thread],
          });
        } else {
          if (project !== undefined) existing.projects.set(project.id, project);
          existing.threads.push(thread);
        }
      }
      const discoveredPaths = yield* Effect.forEach(
        snapshots.inventory.paths,
        (worktreePath) =>
          fileSystem.realPath(worktreePath).pipe(
            Effect.orElseSucceed(() => path.resolve(worktreePath)),
            Effect.map((key) => ({ key, worktreePath })),
          ),
        { concurrency: SIZE_SCAN_CONCURRENCY },
      );
      for (const discovered of discoveredPaths) {
        if (!associations.has(discovered.key)) {
          associations.set(discovered.key, {
            worktreePath: discovered.worktreePath,
            projects: new Map(),
            threads: [],
          });
        }
      }
      const liveProviderSessions = snapshots.providerSessions.filter(
        (session) =>
          session.status === "connecting" ||
          session.status === "ready" ||
          session.status === "running",
      );
      const liveProviderThreadIds = new Set(
        liveProviderSessions.map((session) => session.threadId),
      );
      const liveProviderPaths = yield* Effect.forEach(
        liveProviderSessions,
        (session) =>
          session.cwd === undefined
            ? Effect.succeed(null)
            : fileSystem
                .realPath(session.cwd)
                .pipe(Effect.orElseSucceed(() => path.resolve(session.cwd!))),
        { concurrency: SIZE_SCAN_CONCURRENCY },
      );
      const liveTerminals = snapshots.terminalSummaries.filter(
        (terminal) =>
          terminal.status === "starting" ||
          terminal.status === "running" ||
          terminal.hasRunningSubprocess,
      );
      const liveTerminalPaths = yield* Effect.forEach(
        liveTerminals.flatMap((terminal) => [terminal.worktreePath, terminal.cwd]),
        (terminalPath) =>
          terminalPath === null
            ? Effect.succeed(null)
            : fileSystem
                .realPath(terminalPath)
                .pipe(Effect.orElseSucceed(() => path.resolve(terminalPath))),
        { concurrency: SIZE_SCAN_CONCURRENCY },
      );
      return {
        associations: [...associations.entries()]
          .map(([key, value]) => ({
            key,
            worktreePath: value.worktreePath,
            projects: [...value.projects.values()].sort((left, right) =>
              left.id.localeCompare(right.id),
            ),
            threads: [...value.threads].sort((left, right) => left.id.localeCompare(right.id)),
          }))
          .sort((left, right) => left.key.localeCompare(right.key)),
        threadsById: new Map(
          [...snapshots.active.threads, ...snapshots.archived.threads].map(
            (thread) => [thread.id, thread] as const,
          ),
        ),
        liveProviderThreadIds,
        liveProviderPaths: liveProviderPaths.filter(
          (providerPath): providerPath is string => providerPath !== null,
        ),
        liveTerminalThreadIds: new Set(liveTerminals.map((terminal) => terminal.threadId)),
        liveTerminalPaths: liveTerminalPaths.filter(
          (worktreePath): worktreePath is string => worktreePath !== null,
        ),
        inventoryErrors: snapshots.inventory.failures.map((failure) =>
          scanError(`inventory-${failure.operation}`, failure.cause, failure.path),
        ),
      };
    },
  );

  const scanCandidate = Effect.fn("WorktreeStorage.scanCandidate")(function* (
    association: CandidateAssociation,
    context: ScanContext,
    mode: ScanMode,
  ): Effect.fn.Return<InternalCandidateScan> {
    const reasons = new Set<WorktreeStorageProtectionReason>();
    const errors: WorktreeStorageScanError[] = [];
    let canonicalRoot: string | null = null;
    let canonicalCandidate: string | null = null;
    const canonical = yield* Effect.result(
      Effect.all({
        root: fileSystem.realPath(config.worktreesDir),
        candidate: fileSystem.realPath(association.worktreePath),
      }),
    );
    if (Result.isFailure(canonical)) {
      const exists = yield* fileSystem
        .exists(association.worktreePath)
        .pipe(Effect.orElseSucceed(() => false));
      reasons.add(exists ? "inspection-error" : "missing");
      errors.push(scanError("canonicalize", canonical.failure, association.worktreePath));
    } else {
      canonicalRoot = canonical.success.root;
      canonicalCandidate = canonical.success.candidate;
      addReason(
        reasons,
        !isCanonicallyContained(path, canonicalRoot, canonicalCandidate),
        "outside-managed-root",
      );
    }
    for (const reason of associationReasons({
      projectCount: association.projects.length,
      hasLiveTerminalPath: hasLivePathUse(
        path,
        canonicalCandidate ?? association.key,
        context.liveTerminalPaths,
      ),
    })) {
      reasons.add(reason);
    }
    addReason(
      reasons,
      hasLivePathUse(path, canonicalCandidate ?? association.key, context.liveProviderPaths),
      "live-provider",
    );
    addReason(reasons, shouldProtectOrphan(association.threads.length), "unowned-or-orphaned");
    for (const thread of association.threads) {
      for (const reason of threadReasons(
        thread,
        mode,
        context.liveProviderThreadIds,
        context.liveTerminalThreadIds,
      )) {
        reasons.add(reason);
      }
    }

    const size = yield* measureDirectoryNoFollow(association.worktreePath);
    errors.push(...size.errors.slice(0, WORKTREE_STORAGE_MAX_ERRORS - errors.length));
    if (size.errors.length > 0) reasons.add("inspection-error");

    let gitInspection: GitInspectionResult = {
      reasons: [],
      errors: [],
      mainWorktreePath: null,
      targetWorktreePath: null,
    };
    if (canonicalCandidate !== null && reasons.has("outside-managed-root") === false) {
      gitInspection = yield* inspectGitCandidate(canonicalCandidate);
      for (const reason of gitInspection.reasons) reasons.add(reason);
      errors.push(...gitInspection.errors.slice(0, WORKTREE_STORAGE_MAX_ERRORS - errors.length));
    }

    const project = association.projects[0];
    // A thread cannot exist without a project, but fail closed if projection data is inconsistent.
    if (project === undefined && association.threads.length > 0) {
      reasons.add("inspection-error");
    }
    const stale =
      mode.mode === "manual"
        ? association.threads.every(
            (thread) => thread.archivedAt !== null || thread.settledAt !== null,
          )
        : association.threads.length > 0 &&
          !reasons.has("recent-activity") &&
          !reasons.has("inspection-error");
    const sortedReasons = [...reasons].sort();
    return {
      key: association.key,
      association,
      mainWorktreePath: gitInspection.mainWorktreePath,
      removalPath: gitInspection.targetWorktreePath,
      detail: {
        projectId: project?.id ?? null,
        projectTitle: project?.title ?? "Unassigned worktree",
        worktreePath: association.worktreePath,
        bytes: size.bytes,
        associatedThreadCount: association.threads.length,
        associatedThreadIds: association.threads
          .map((thread) => thread.id)
          .slice(0, WORKTREE_STORAGE_MAX_ASSOCIATED_THREAD_IDS),
        latestActivityAt: aggregateLatestActivity(association.threads),
        stale,
        eligible: stale && sortedReasons.length === 0,
        protectionReasons: sortedReasons,
        scanErrors: errors.slice(0, WORKTREE_STORAGE_MAX_ERRORS),
      },
    };
  });

  const scanAll = Effect.fn("WorktreeStorage.scanAll")(function* (
    mode: ScanMode,
    startIndex = 0,
  ): Effect.fn.Return<CandidateScanBatch, WorktreeStorageError> {
    const context = yield* loadScanContext();
    const window = selectCandidateWindow(context.associations, startIndex);
    const scans = yield* Effect.forEach(
      window.selected,
      (association) => scanCandidate(association, context, mode),
      { concurrency: SIZE_SCAN_CONCURRENCY },
    );
    return {
      scans,
      omittedCandidateCount: window.omittedCandidateCount,
      inventoryErrors: context.inventoryErrors,
    };
  });

  const makeReport = Effect.fn("WorktreeStorage.makeReport")(function* (): Effect.fn.Return<
    WorktreeStorageReport,
    WorktreeStorageError
  > {
    const scannedAt = DateTime.formatIso(yield* DateTime.now);
    const batch = yield* scanAll({ mode: "manual" });
    const scans = batch.scans;
    const aggregates = new Map<ProjectId, WorktreeStorageProjectAggregate>();
    for (const scan of scans) {
      for (const project of scan.association.projects) {
        const current = aggregates.get(project.id) ?? {
          projectId: project.id,
          projectTitle: project.title,
          bytes: 0,
          worktreeCount: 0,
          staleWorktreeCount: 0,
          eligibleWorktreeCount: 0,
        };
        aggregates.set(project.id, {
          ...current,
          bytes: safeByteCount(current.bytes + scan.detail.bytes),
          worktreeCount: current.worktreeCount + 1,
          staleWorktreeCount: current.staleWorktreeCount + (scan.detail.stale ? 1 : 0),
          eligibleWorktreeCount: current.eligibleWorktreeCount + (scan.detail.eligible ? 1 : 0),
        });
      }
    }
    const projects = rankProjects([...aggregates.values()]);
    const details = rankDetails(scans.map((scan) => scan.detail));
    const errors = [
      ...(batch.omittedCandidateCount > 0
        ? [
            scanError(
              "candidate-budget",
              `${batch.omittedCandidateCount} worktree candidates were omitted from this bounded scan.`,
            ),
          ]
        : []),
      ...batch.inventoryErrors,
      ...scans.flatMap((scan) => scan.detail.scanErrors),
    ].slice(0, WORKTREE_STORAGE_MAX_ERRORS);
    return {
      scannedAt,
      totalBytes: safeByteCount(scans.reduce((total, scan) => total + scan.detail.bytes, 0)),
      worktreeCount: scans.length,
      staleWorktreeCount: scans.filter((scan) => scan.detail.stale).length,
      eligibleWorktreeCount: scans.filter((scan) => scan.detail.eligible).length,
      projects: projects.slice(0, WORKTREE_STORAGE_MAX_PROJECTS),
      projectCount: projects.length,
      details: details.slice(0, WORKTREE_STORAGE_MAX_DETAILS),
      detailCount: details.length,
      errors,
      partial:
        batch.omittedCandidateCount > 0 ||
        errors.length > 0 ||
        projects.length > WORKTREE_STORAGE_MAX_PROJECTS ||
        details.length > WORKTREE_STORAGE_MAX_DETAILS,
    };
  });

  const getReport = Effect.fn("WorktreeStorage.getReport")(function* () {
    return yield* makeReport();
  });

  const verifyPersistedThreadPathEvent = Effect.fn(
    "WorktreeStorage.verifyPersistedThreadPathEvent",
  )(function* (input: {
    readonly sequence: number;
    readonly threadId: ThreadId;
    readonly worktreePath: string | null;
  }) {
    const event = yield* engine
      .readEvents(input.sequence - 1, 1)
      .pipe(Stream.runHead, Effect.map(Option.getOrNull));
    return (
      event !== null &&
      isAppliedThreadPathEvent({
        event,
        sequence: input.sequence,
        threadId: input.threadId,
        worktreePath: input.worktreePath,
      })
    );
  });

  const reserveMatchingThreadPaths = Effect.fn("WorktreeStorage.reserveMatchingThreadPaths")(
    function* (association: CandidateAssociation): Effect.fn.Return<ThreadPathReservation> {
      const errors: WorktreeStorageScanError[] = [];
      const reserved: ReservedThreadPath[] = [];
      for (const thread of association.threads) {
        const uuidResult = yield* Effect.result(crypto.randomUUIDv4);
        if (Result.isFailure(uuidResult)) {
          if (errors.length < WORKTREE_STORAGE_MAX_ERRORS) {
            errors.push(
              scanError("clear-thread-worktree", uuidResult.failure, association.worktreePath),
            );
          }
          continue;
        }
        const clearCommandId = CommandId.make(`server:worktree-prune:${uuidResult.success}`);
        const result = yield* Effect.result(
          engine.dispatch({
            type: "thread.meta.update",
            commandId: clearCommandId,
            threadId: ThreadId.make(thread.id),
            worktreePath: null,
            expectedWorktreePath: thread.worktreePath,
          }),
        );
        if (Result.isFailure(result) && errors.length < WORKTREE_STORAGE_MAX_ERRORS) {
          errors.push(scanError("clear-thread-worktree", result.failure, association.worktreePath));
        } else if (Result.isSuccess(result)) {
          const appliedResult = yield* Effect.result(
            verifyPersistedThreadPathEvent({
              sequence: result.success.sequence,
              threadId: ThreadId.make(thread.id),
              worktreePath: null,
            }),
          );
          if (Result.isSuccess(appliedResult) && appliedResult.success) {
            reserved.push({
              thread,
              restoreCommandId: CommandId.make(`${clearCommandId}:restore`),
            });
          } else {
            // If the exact event cannot be read, conservatively include the
            // path in cleanup. The expected-null restore CAS cannot overwrite
            // a concurrent rebound path.
            if (Result.isFailure(appliedResult)) {
              reserved.push({
                thread,
                restoreCommandId: CommandId.make(`${clearCommandId}:restore`),
              });
            }
            if (errors.length < WORKTREE_STORAGE_MAX_ERRORS) {
              errors.push(
                scanError(
                  "clear-thread-worktree-cas",
                  Result.isFailure(appliedResult)
                    ? appliedResult.failure
                    : "The persisted metadata event did not apply the expected worktree path.",
                  association.worktreePath,
                ),
              );
            }
          }
        }
      }
      return { threads: reserved, errors };
    },
  );

  const restoreReservedThreadPaths = Effect.fn("WorktreeStorage.restoreReservedThreadPaths")(
    function* (
      threads: ReadonlyArray<ReservedThreadPath>,
    ): Effect.fn.Return<ReadonlyArray<WorktreeStorageScanError>> {
      const errors: WorktreeStorageScanError[] = [];
      for (const reserved of threads) {
        const { thread } = reserved;
        if (thread.worktreePath === null) continue;
        const result = yield* Effect.result(
          engine.dispatch({
            type: "thread.meta.update",
            commandId: reserved.restoreCommandId,
            threadId: ThreadId.make(thread.id),
            worktreePath: thread.worktreePath,
            expectedWorktreePath: null,
          }),
        );
        if (Result.isFailure(result) && errors.length < WORKTREE_STORAGE_MAX_ERRORS) {
          errors.push(scanError("restore-thread-worktree", result.failure, thread.worktreePath));
        } else if (Result.isSuccess(result)) {
          const appliedResult = yield* Effect.result(
            verifyPersistedThreadPathEvent({
              sequence: result.success.sequence,
              threadId: ThreadId.make(thread.id),
              worktreePath: thread.worktreePath,
            }),
          );
          if (
            (Result.isFailure(appliedResult) || !appliedResult.success) &&
            errors.length < WORKTREE_STORAGE_MAX_ERRORS
          ) {
            errors.push(
              scanError(
                "restore-thread-worktree-cas",
                Result.isFailure(appliedResult)
                  ? appliedResult.failure
                  : "The persisted metadata event did not restore the reserved worktree path.",
                thread.worktreePath,
              ),
            );
          }
        }
      }
      return errors;
    },
  );

  const pruneForMode = Effect.fn("WorktreeStorage.pruneForMode")(function* (
    mode: ScanMode,
  ): Effect.fn.Return<WorktreeStoragePruneResult, WorktreeStorageError> {
    return yield* pruneLock.withPermits(1)(
      Effect.gen(function* () {
        const startedAt = DateTime.formatIso(yield* DateTime.now);
        const cursor = yield* Ref.get(pruneCursor);
        const initialBatch = yield* scanAll(mode, cursor);
        const initial = initialBatch.scans;
        yield* Ref.set(
          pruneCursor,
          cursor + Math.max(1, Math.min(MAX_CANDIDATES_PER_SCAN, initial.length)),
        );
        const outcomes: WorktreeStoragePruneOutcome[] = [];
        const errors: WorktreeStorageScanError[] = [
          ...(initialBatch.omittedCandidateCount > 0
            ? [
                scanError(
                  "candidate-budget",
                  `${initialBatch.omittedCandidateCount} worktree candidates were deferred to a later prune pass.`,
                ),
              ]
            : []),
          ...initialBatch.inventoryErrors,
        ].slice(0, WORKTREE_STORAGE_MAX_ERRORS);
        let reclaimedBytes = 0;
        let removedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (const initialScan of [...initial].sort((left, right) =>
          left.key.localeCompare(right.key),
        )) {
          const context = yield* loadScanContext();
          const association = context.associations.find((item) => item.key === initialScan.key);
          if (association === undefined) {
            skippedCount += 1;
            outcomes.push({
              worktreePath: initialScan.association.worktreePath,
              projectId: initialScan.detail.projectId,
              bytes: initialScan.detail.bytes,
              status: "skipped",
              protectionReasons: ["locked-or-unknown"],
            });
            continue;
          }
          const fresh = yield* scanCandidate(association, context, mode);
          if (
            !fresh.detail.eligible ||
            fresh.mainWorktreePath === null ||
            fresh.removalPath === null
          ) {
            skippedCount += 1;
            outcomes.push({
              worktreePath: fresh.detail.worktreePath,
              projectId: fresh.detail.projectId,
              bytes: fresh.detail.bytes,
              status: "skipped",
              protectionReasons:
                fresh.detail.protectionReasons.length > 0
                  ? fresh.detail.protectionReasons
                  : ["inspection-error"],
            });
            errors.push(
              ...fresh.detail.scanErrors.slice(0, WORKTREE_STORAGE_MAX_ERRORS - errors.length),
            );
            continue;
          }

          const reservation = yield* reserveMatchingThreadPaths(fresh.association).pipe(
            Effect.uninterruptible,
          );
          const restoreReservation = restoreReservedThreadPaths(reservation.threads).pipe(
            Effect.tap((restoreErrors) =>
              Effect.sync(() => {
                errors.push(...restoreErrors.slice(0, WORKTREE_STORAGE_MAX_ERRORS - errors.length));
              }),
            ),
            Effect.asVoid,
            Effect.uninterruptible,
          );
          const removed = yield* withReservationRestoration(
            Effect.gen(function* () {
              if (reservation.errors.length > 0) {
                errors.push(
                  ...reservation.errors.slice(0, WORKTREE_STORAGE_MAX_ERRORS - errors.length),
                );
                skippedCount += 1;
                outcomes.push({
                  worktreePath: fresh.detail.worktreePath,
                  projectId: fresh.detail.projectId,
                  bytes: fresh.detail.bytes,
                  status: "skipped",
                  protectionReasons: ["inspection-error"],
                });
                return { value: null, physicalRemovalSucceeded: false } as const;
              }

              const reservedContext = yield* loadScanContext();
              const reservedAssociation = reservedContext.associations.find(
                (item) => item.key === fresh.key,
              );
              const reservedThreadIds = new Set(
                fresh.association.threads.map((thread) => thread.id),
              );
              const reservedThreads = fresh.association.threads.flatMap((thread) => {
                const current = reservedContext.threadsById.get(thread.id);
                return current === undefined ? [] : [current];
              });
              const reservedThreadBecameLive =
                [...reservedThreadIds].some((threadId) =>
                  reservedContext.liveProviderThreadIds.has(threadId),
                ) ||
                [...reservedThreadIds].some((threadId) =>
                  reservedContext.liveTerminalThreadIds.has(threadId),
                );
              if (
                reservedAssociation === undefined ||
                !reservationIsValid({
                  candidateStillRegistered: true,
                  associationThreadCount: reservedAssociation.threads.length,
                  expectedThreadCount: fresh.association.threads.length,
                  currentThreadPaths: reservedThreads.map((thread) => thread.worktreePath),
                  becameLive: reservedThreadBecameLive,
                })
              ) {
                if (errors.length < WORKTREE_STORAGE_MAX_ERRORS) {
                  errors.push(
                    scanError(
                      "verify-thread-reservation",
                      "A worktree reference changed while the prune reservation was being verified.",
                      fresh.detail.worktreePath,
                    ),
                  );
                }
                skippedCount += 1;
                outcomes.push({
                  worktreePath: fresh.detail.worktreePath,
                  projectId: fresh.detail.projectId,
                  bytes: fresh.detail.bytes,
                  status: "skipped",
                  protectionReasons: ["locked-or-unknown"],
                });
                return { value: null, physicalRemovalSucceeded: false } as const;
              }

              const verified = yield* scanCandidate(
                {
                  ...reservedAssociation,
                  projects: fresh.association.projects,
                  threads: reservedThreads,
                },
                reservedContext,
                mode,
              );
              if (
                !verified.detail.eligible ||
                verified.mainWorktreePath === null ||
                verified.removalPath === null
              ) {
                errors.push(
                  ...verified.detail.scanErrors.slice(
                    0,
                    WORKTREE_STORAGE_MAX_ERRORS - errors.length,
                  ),
                );
                skippedCount += 1;
                outcomes.push({
                  worktreePath: fresh.detail.worktreePath,
                  projectId: fresh.detail.projectId,
                  bytes: verified.detail.bytes,
                  status: "skipped",
                  protectionReasons:
                    verified.detail.protectionReasons.length > 0
                      ? verified.detail.protectionReasons
                      : ["inspection-error"],
                });
                return { value: null, physicalRemovalSucceeded: false } as const;
              }
              const mainWorktreePath = verified.mainWorktreePath;
              const removalPath = verified.removalPath;

              // Once Git removal begins, observe its bounded result before
              // deciding whether the reservation must be restored.
              return yield* Effect.gen(function* () {
                const removeResult = yield* Effect.result(
                  runGit(mainWorktreePath, worktreeRemovalArgs(removalPath)),
                );
                const removalSucceeded =
                  Result.isSuccess(removeResult) && removeResult.success.exitCode === 0;
                if (shouldRestoreReservedPaths(removalSucceeded)) {
                  const cause = Result.isFailure(removeResult)
                    ? removeResult.failure
                    : removeResult.success.stderr || `git exited ${removeResult.success.exitCode}`;
                  failedCount += 1;
                  outcomes.push({
                    worktreePath: fresh.detail.worktreePath,
                    projectId: fresh.detail.projectId,
                    bytes: fresh.detail.bytes,
                    status: "failed",
                    protectionReasons: [],
                    message: boundedMessage(cause),
                  });
                  if (errors.length < WORKTREE_STORAGE_MAX_ERRORS) {
                    errors.push(scanError("git-worktree-remove", cause, fresh.detail.worktreePath));
                  }
                  return { value: null, physicalRemovalSucceeded: false } as const;
                }

                return { value: verified, physicalRemovalSucceeded: true } as const;
              }).pipe(Effect.uninterruptible);
            }),
            restoreReservation,
          );

          if (removed !== null) {
            removedCount += 1;
            reclaimedBytes = safeByteCount(reclaimedBytes + removed.detail.bytes);
            const project = fresh.association.projects[0];
            if (project !== undefined) {
              yield* vcsStatus.refreshLocalStatus(project.workspaceRoot).pipe(Effect.ignore);
            }
            outcomes.push({
              worktreePath: fresh.detail.worktreePath,
              projectId: fresh.detail.projectId,
              bytes: removed.detail.bytes,
              status: "removed",
              protectionReasons: [],
            });
          }
        }

        const completedAt = DateTime.formatIso(yield* DateTime.now);
        const sortedOutcomes = outcomes.sort((left, right) =>
          left.worktreePath.localeCompare(right.worktreePath),
        );
        return {
          startedAt,
          completedAt,
          removedCount,
          skippedCount,
          failedCount,
          reclaimedBytes,
          outcomes: sortedOutcomes.slice(0, WORKTREE_STORAGE_MAX_OUTCOMES),
          outcomeCount: sortedOutcomes.length,
          errors: errors.slice(0, WORKTREE_STORAGE_MAX_ERRORS),
          partial:
            initialBatch.omittedCandidateCount > 0 ||
            errors.length > 0 ||
            failedCount > 0 ||
            sortedOutcomes.length > WORKTREE_STORAGE_MAX_OUTCOMES,
        };
      }),
    );
  });

  const runConfiguredAutomaticPrune = Effect.fn("WorktreeStorage.runConfiguredAutomaticPrune")(
    function* () {
      const policy = (yield* settings.getSettings).worktreeAutoPrunePolicy;
      const mode = automaticScanMode(policy, DateTime.toEpochMillis(yield* DateTime.now));
      if (mode === null) return;
      yield* pruneForMode(mode).pipe(
        Effect.tap((result) =>
          result.removedCount > 0 || result.failedCount > 0
            ? Effect.logInfo("Automatic worktree prune completed", {
                removedCount: result.removedCount,
                failedCount: result.failedCount,
                skippedCount: result.skippedCount,
              })
            : Effect.void,
        ),
      );
    },
  );

  const settingsChanges = yield* settings.subscribeChanges;
  const initialPolicy = (yield* settings.getSettings).worktreeAutoPrunePolicy;
  const automaticEventTriggers = Stream.merge(
    Stream.concat(
      Stream.succeed(initialPolicy),
      settingsChanges.pipe(Stream.map((next) => next.worktreeAutoPrunePolicy)),
    ).pipe(
      Stream.map(automaticPolicyKey),
      Stream.changes,
      Stream.drop(1),
      Stream.filter((key) => key !== "off"),
      Stream.map(() => undefined),
    ),
    engine.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "thread.settled" || event.type === "thread.archived"),
      Stream.mapEffect(() => settings.getSettings),
      Stream.filter((next) => next.worktreeAutoPrunePolicy.mode === "on-settle"),
      Stream.map(() => undefined),
    ),
  ).pipe(Stream.debounce(Duration.seconds(1)));
  yield* automaticEventTriggers.pipe(
    Stream.runForEach(() =>
      runConfiguredAutomaticPrune().pipe(
        Effect.catch((cause) => Effect.logWarning("Automatic worktree prune failed", { cause })),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Effect.forever(
    Effect.sleep(AUTO_SWEEP_INTERVAL).pipe(
      Effect.andThen(
        settings.getSettings.pipe(
          Effect.flatMap((current) =>
            shouldRunAutomaticFallback(current.worktreeAutoPrunePolicy)
              ? runConfiguredAutomaticPrune()
              : Effect.void,
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Fallback automatic worktree prune failed", { cause }),
          ),
        ),
      ),
    ),
  ).pipe(Effect.forkScoped);

  return {
    getReport: getReport(),
    pruneStale: pruneForMode({ mode: "manual" }),
  } satisfies WorktreeStorageService;
});

export const layer = Layer.effect(WorktreeStorage, make);
