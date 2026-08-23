import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type WorktreeStorageDetail,
  type WorktreeStorageProjectAggregate,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  associationReasons,
  automaticPolicyKey,
  automaticScanMode,
  decodeWorktreePorcelain,
  hasLivePathUse,
  isAppliedThreadPathEvent,
  isCanonicallyContained,
  parseWorktreePorcelain,
  rankDetails,
  rankProjects,
  reservationIsValid,
  selectCandidateWindow,
  shouldProtectOrphan,
  shouldRunAutomaticFallback,
  shouldRestoreReservedPaths,
  threadReasons,
  withReservationRestoration,
  worktreeListOutputError,
  worktreeRemovalArgs,
} from "./WorktreeStorage.ts";

const OLD = "2026-01-01T00:00:00.000Z";

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: "/managed/worktree",
    latestTurn: null,
    createdAt: OLD,
    updatedAt: OLD,
    archivedAt: null,
    settledOverride: "settled",
    settledAt: OLD,
    session: null,
    latestUserMessageAt: OLD,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    planProgress: null,
    ...overrides,
  };
}

function makeDetail(worktreePath: string, bytes: number): WorktreeStorageDetail {
  return {
    projectId: ProjectId.make("project-1"),
    projectTitle: "Project",
    worktreePath,
    bytes,
    associatedThreadCount: 1,
    associatedThreadIds: [ThreadId.make("thread-1")],
    latestActivityAt: OLD,
    stale: true,
    eligible: true,
    protectionReasons: [],
    scanErrors: [],
  };
}

it.layer(NodeServices.layer)("worktree storage safety decisions", (it) => {
  it.effect("uses canonical containment and excludes the managed root itself", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(isCanonicallyContained(path, "/managed", "/managed/worktree")).toBe(true);
      expect(isCanonicallyContained(path, "/managed", "/managed")).toBe(false);
      expect(isCanonicallyContained(path, "/managed", "/managed-other/worktree")).toBe(false);
      expect(hasLivePathUse(path, "/managed/worktree", ["/managed/worktree/subdirectory"])).toBe(
        true,
      );
      expect(hasLivePathUse(path, "/managed/worktree", ["/managed/other"])).toBe(false);
    }),
  );

  it("protects shared and live-terminal associations", () => {
    expect(associationReasons({ projectCount: 2, hasLiveTerminalPath: true })).toEqual([
      "shared-across-projects",
      "live-terminal",
    ]);
  });

  it("protects active, provider, terminal, approval, input, plan, and background liveness", () => {
    const thread = makeThread({
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: OLD,
      },
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: true,
      backgroundLiveness: "working",
    });
    const reasons = threadReasons(
      thread,
      { mode: "manual" },
      new Set([thread.id]),
      new Set([thread.id]),
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        "active-turn-or-session",
        "live-provider",
        "live-terminal",
        "pending-approval",
        "pending-input",
        "pending-plan",
        "background-liveness",
      ]),
    );
  });

  it("gates automatic modes and protects activity at the cutoff", () => {
    const nowMs = Date.parse("2026-02-01T00:00:00.000Z");
    expect(automaticScanMode({ mode: "off" }, nowMs)).toBeNull();
    expect(automaticScanMode({ mode: "on-settle" }, nowMs)).toEqual({
      mode: "manual",
    });
    const mode = automaticScanMode({ mode: "after-inactive-days", inactivityDays: 7 }, nowMs);
    expect(mode).toEqual({ mode: "inactive", cutoffMs: nowMs - 7 * 24 * 60 * 60 * 1_000 });
    if (mode !== null) {
      expect(threadReasons(makeThread(), mode, new Set(), new Set())).not.toContain(
        "recent-activity",
      );
      expect(shouldProtectOrphan(0)).toBe(true);
    }
    expect(shouldProtectOrphan(0)).toBe(true);
    expect(shouldProtectOrphan(1)).toBe(false);
    expect(automaticPolicyKey({ mode: "off" })).toBe("off");
    expect(automaticPolicyKey({ mode: "on-settle" })).toBe("on-settle");
    expect(automaticPolicyKey({ mode: "after-inactive-days", inactivityDays: 30 })).toBe(
      "after-inactive-days:30",
    );
    expect(shouldRunAutomaticFallback({ mode: "on-settle" })).toBe(false);
    expect(shouldRunAutomaticFallback({ mode: "after-inactive-days", inactivityDays: 30 })).toBe(
      true,
    );
  });

  it.effect("deduplicates automatic triggers by policy value", () =>
    Stream.fromIterable([
      { mode: "on-settle" } as const,
      { mode: "on-settle" } as const,
      { mode: "after-inactive-days", inactivityDays: 30 } as const,
      { mode: "after-inactive-days", inactivityDays: 30 } as const,
      { mode: "after-inactive-days", inactivityDays: 60 } as const,
    ]).pipe(
      Stream.map(automaticPolicyKey),
      Stream.changes,
      Stream.runCollect,
      Effect.map((keys) =>
        expect(Array.from(keys)).toEqual([
          "on-settle",
          "after-inactive-days:30",
          "after-inactive-days:60",
        ]),
      ),
    ),
  );

  it("restores reserved metadata only when physical removal fails", () => {
    expect(shouldRestoreReservedPaths(false)).toBe(true);
    expect(shouldRestoreReservedPaths(true)).toBe(false);
  });

  it("distinguishes an applied path CAS from its persisted no-op event", () => {
    const threadId = ThreadId.make("thread-cas");
    const base = {
      sequence: 42,
      eventId: EventId.make("event-cas"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: OLD,
      commandId: CommandId.make("command-cas"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.meta-updated",
    } as const;
    const applied: OrchestrationEvent = {
      ...base,
      payload: { threadId, worktreePath: null, updatedAt: OLD },
    };
    const mismatch: OrchestrationEvent = {
      ...base,
      payload: { threadId, updatedAt: OLD },
    };
    expect(
      isAppliedThreadPathEvent({ event: applied, sequence: 42, threadId, worktreePath: null }),
    ).toBe(true);
    expect(
      isAppliedThreadPathEvent({ event: mismatch, sequence: 42, threadId, worktreePath: null }),
    ).toBe(false);
    expect(
      reservationIsValid({
        candidateStillRegistered: true,
        associationThreadCount: 0,
        expectedThreadCount: 1,
        currentThreadPaths: [null],
        becameLive: false,
      }),
    ).toBe(true);
    expect(
      reservationIsValid({
        candidateStillRegistered: true,
        associationThreadCount: 0,
        expectedThreadCount: 1,
        currentThreadPaths: ["/managed/rebound"],
        becameLive: false,
      }),
    ).toBe(false);
  });

  it.effect("finalizes reservations on failure and interruption but not successful removal", () =>
    Effect.gen(function* () {
      const restoreCount = yield* Ref.make(0);
      const restore = Ref.update(restoreCount, (count) => count + 1);

      const failed = yield* Effect.result(
        withReservationRestoration(Effect.fail("failed before removal"), restore),
      );
      expect(Result.isFailure(failed)).toBe(true);
      expect(yield* Ref.get(restoreCount)).toBe(1);

      yield* withReservationRestoration(
        Effect.succeed({ value: undefined, physicalRemovalSucceeded: false }),
        restore,
      );
      expect(yield* Ref.get(restoreCount)).toBe(2);

      const entered = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      const interrupted = yield* withReservationRestoration(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(blocked)),
          Effect.as({ value: undefined, physicalRemovalSucceeded: false }),
        ),
        restore,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(interrupted);
      expect(yield* Ref.get(restoreCount)).toBe(3);

      yield* withReservationRestoration(
        Effect.succeed({ value: undefined, physicalRemovalSucceeded: true }),
        restore,
      );
      expect(yield* Ref.get(restoreCount)).toBe(3);
    }),
  );

  it("treats detached, locked, and prunable porcelain entries as unsafe metadata", () => {
    const validOutput =
      "worktree /main\0HEAD abc\0branch refs/heads/main\0\0" +
      "worktree /detached\0HEAD def\0detached\0\0" +
      "worktree /locked\0HEAD ghi\0branch refs/heads/locked\0locked reason\0\0" +
      "worktree /prunable\0HEAD jkl\0branch refs/heads/prunable\0prunable reason\0\0";
    expect(parseWorktreePorcelain(validOutput)).toEqual([
      { path: "/main", locked: false, prunable: false, detached: false },
      { path: "/detached", locked: false, prunable: false, detached: true },
      { path: "/locked", locked: true, prunable: false, detached: false },
      { path: "/prunable", locked: false, prunable: true, detached: false },
    ]);
    expect("entries" in decodeWorktreePorcelain(validOutput)).toBe(true);

    expect("error" in decodeWorktreePorcelain("worktree /detached\0HEAD def\0")).toBe(true);
    expect("error" in decodeWorktreePorcelain("worktree /detached\0HEAD def\0\0")).toBe(true);
    expect(worktreeListOutputError({ stdoutTruncated: true })).toContain("safety limit");
    expect(worktreeListOutputError({ stdoutTruncated: false, stdoutInvalidUtf8: true })).toContain(
      "UTF-8",
    );
    expect(
      worktreeListOutputError({ stdoutTruncated: false, stdoutInvalidUtf8: false }),
    ).toBeNull();
  });

  it("uses stable ranking tie-breakers and a non-force removal command", () => {
    const projects: WorktreeStorageProjectAggregate[] = [
      {
        projectId: ProjectId.make("project-b"),
        projectTitle: "B",
        bytes: 10,
        worktreeCount: 1,
        staleWorktreeCount: 1,
        eligibleWorktreeCount: 1,
      },
      {
        projectId: ProjectId.make("project-a"),
        projectTitle: "A",
        bytes: 10,
        worktreeCount: 1,
        staleWorktreeCount: 1,
        eligibleWorktreeCount: 1,
      },
      {
        projectId: ProjectId.make("project-c"),
        projectTitle: "C",
        bytes: 20,
        worktreeCount: 1,
        staleWorktreeCount: 1,
        eligibleWorktreeCount: 1,
      },
    ];
    expect(rankProjects(projects).map((project) => project.projectId)).toEqual([
      "project-c",
      "project-a",
      "project-b",
    ]);
    expect(
      rankDetails([makeDetail("/managed/b", 10), makeDetail("/managed/a", 10)]).map(
        (detail) => detail.worktreePath,
      ),
    ).toEqual(["/managed/a", "/managed/b"]);
    expect(worktreeRemovalArgs("/managed/worktree")).toEqual([
      "worktree",
      "remove",
      "/managed/worktree",
    ]);
    expect(worktreeRemovalArgs("/managed/worktree")).not.toContain("--force");
  });

  it("bounds and rotates aggregate candidate scans", () => {
    expect(selectCandidateWindow(["a", "b", "c", "d"], 2, 2)).toEqual({
      selected: ["c", "d"],
      omittedCandidateCount: 2,
    });
    expect(selectCandidateWindow(["a", "b", "c", "d"], 3, 2)).toEqual({
      selected: ["d", "a"],
      omittedCandidateCount: 2,
    });
  });
});
