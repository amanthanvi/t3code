// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorktreeStorage from "./WorktreeStorage.ts";

const OLD = "2025-01-01T00:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

function processOutput(
  input: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  } = {},
): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(input.exitCode ?? 0),
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

function makeProject(mainPath: string): OrchestrationProjectShell {
  return {
    id: ProjectId.make("project-service"),
    title: "Project",
    workspaceRoot: mainPath,
    defaultModelSelection: null,
    scripts: [],
    createdAt: OLD,
    updatedAt: OLD,
  };
}

function makeThread(
  worktreePath: string | null,
  id: ThreadId = ThreadId.make("thread-service"),
): OrchestrationThreadShell {
  return {
    id,
    projectId: ProjectId.make("project-service"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath,
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
  };
}

const makeHarness = Effect.fn("WorktreeStorage.serviceTest.makeHarness")(function* (input: {
  readonly remove: "success" | "failure" | "blocked-failure";
  readonly rebindBeforeReservation?: boolean;
  readonly failProjectionLoad?: boolean;
  readonly statusStdout?: string;
  readonly statusStdouts?: ReadonlyArray<string>;
  readonly secondThread?: boolean;
  readonly defectOnFirstRestore?: boolean;
  readonly defectOnSecondClear?: boolean;
}) {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".worktree-storage-service-test-")),
  );
  temporaryDirectories.push(root);
  const mainPath = NodePath.join(root, "main");
  const candidatePath = NodePath.join(root, "worktrees", "feature");
  const reboundPath = NodePath.join(root, "worktrees", "rebound");
  yield* Effect.promise(() =>
    Promise.all([
      NodeFSP.mkdir(mainPath, { recursive: true }),
      NodeFSP.mkdir(candidatePath, { recursive: true }),
    ]),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(NodePath.join(candidatePath, ".git"), "gitdir: test"),
  );

  let threadPath: string | null = candidatePath;
  let secondThreadPath: string | null = input.secondThread === true ? candidatePath : null;
  const firstThreadId = ThreadId.make("thread-service");
  const secondThreadId = ThreadId.make("thread-service-2");
  let sequence = 0;
  let lastEvent: OrchestrationEvent | null = null;
  let removeCallCount = 0;
  let worktreeListCallCount = 0;
  let statusCallCount = 0;
  let statusArgs: ReadonlyArray<string> = [];
  let shouldRebind = input.rebindBeforeReservation === true;
  const removeStarted = yield* Deferred.make<void>();
  const releaseRemove = yield* Deferred.make<void>();
  const project = makeProject(mainPath);

  const engineLayer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type !== "thread.meta.update") {
          throw new Error(`Unexpected command: ${command.type}`);
        }
        const isSecondThread = command.threadId === secondThreadId;
        if (
          input.defectOnFirstRestore === true &&
          command.threadId === firstThreadId &&
          command.commandId.endsWith(":restore")
        ) {
          throw new Error("first restore defect");
        }
        if (
          input.defectOnSecondClear === true &&
          command.threadId === secondThreadId &&
          command.worktreePath === null
        ) {
          throw new Error("second clear defect");
        }
        if (shouldRebind && !isSecondThread && command.worktreePath === null) {
          shouldRebind = false;
          threadPath = reboundPath;
        }
        const currentThreadPath = isSecondThread ? secondThreadPath : threadPath;
        const applied =
          command.expectedWorktreePath === undefined ||
          command.expectedWorktreePath === currentThreadPath;
        if (applied && command.worktreePath !== undefined) {
          if (isSecondThread) {
            secondThreadPath = command.worktreePath;
          } else {
            threadPath = command.worktreePath;
          }
        }
        sequence += 1;
        lastEvent = {
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: OLD,
          commandId: command.commandId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.meta-updated",
          payload: {
            threadId: command.threadId,
            ...(applied && command.worktreePath !== undefined
              ? { worktreePath: command.worktreePath }
              : {}),
            updatedAt: OLD,
          },
        };
        return { sequence };
      }),
    readEvents: (afterSequence) =>
      lastEvent !== null && lastEvent.sequence > afterSequence
        ? Stream.succeed(lastEvent)
        : Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.sync(() => sequence),
  });
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      input.failProjectionLoad === true
        ? Effect.fail(
            new PersistenceSqlError({
              operation: "load-worktree-storage-test-snapshot",
            }),
          )
        : Effect.sync(() => ({
            snapshotSequence: sequence,
            projects: [project],
            threads: [
              makeThread(threadPath, firstThreadId),
              ...(input.secondThread === true
                ? [makeThread(secondThreadPath, secondThreadId)]
                : []),
            ],
            updatedAt: OLD,
          })),
    getArchivedShellSnapshot: () =>
      Effect.sync(() => ({
        snapshotSequence: sequence,
        projects: [],
        threads: [],
        updatedAt: OLD,
      })),
    getThreadShellById: (threadId) =>
      Effect.sync(() =>
        threadId === firstThreadId
          ? Option.some(makeThread(threadPath, firstThreadId))
          : input.secondThread === true && threadId === secondThreadId
            ? Option.some(makeThread(secondThreadPath, secondThreadId))
            : Option.none(),
      ),
  });
  const vcsLayer = Layer.mock(VcsProcess.VcsProcess)({
    run: (request) => {
      const [first, second] = request.args;
      if (first === "worktree" && second === "list") {
        worktreeListCallCount += 1;
        return Effect.succeed(
          processOutput({
            stdout:
              `worktree ${mainPath}\0HEAD abc\0branch refs/heads/main\0\0` +
              `worktree ${candidatePath}\0HEAD def\0branch refs/heads/feature\0\0`,
          }),
        );
      }
      if (first === "status") {
        statusArgs = request.args;
        const stdout = input.statusStdouts?.[statusCallCount] ?? input.statusStdout;
        statusCallCount += 1;
        return Effect.succeed(processOutput(stdout === undefined ? {} : { stdout }));
      }
      if (first === "rev-parse") return Effect.succeed(processOutput({ exitCode: 1 }));
      if (first === "branch") {
        return Effect.succeed(processOutput({ stdout: "refs/remotes/origin/feature\n" }));
      }
      if (first === "worktree" && second === "remove") {
        removeCallCount += 1;
        if (input.remove === "blocked-failure") {
          return Deferred.succeed(removeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRemove)),
            Effect.as(processOutput({ exitCode: 1, stderr: "blocked failure" })),
          );
        }
        return Effect.succeed(
          input.remove === "success"
            ? processOutput()
            : processOutput({ exitCode: 1, stderr: "remove failure" }),
        );
      }
      return Effect.die(`Unexpected Git command: ${request.args.join(" ")}`);
    },
  });

  const configLayer = ServerConfig.layerTest(process.cwd(), root).pipe(
    Layer.provide(NodeServices.layer),
  );
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    configLayer,
    ServerSettings.layerTest({ worktreeAutoPrunePolicy: { mode: "off" } }),
    engineLayer,
    projectionLayer,
    Layer.mock(ProviderService.ProviderService)({ listSessions: () => Effect.succeed([]) }),
    Layer.mock(TerminalManager.TerminalManager)({ listSummaries: Effect.succeed([]) }),
    vcsLayer,
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshLocalStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: false,
          isDefaultRef: false,
          refName: "feature",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
    }),
  );

  return {
    program: WorktreeStorage.make.pipe(Effect.provide(dependencies)),
    candidatePath,
    reboundPath,
    removeStarted,
    releaseRemove,
    get threadPath() {
      return threadPath;
    },
    get secondThreadPath() {
      return secondThreadPath;
    },
    get removeCallCount() {
      return removeCallCount;
    },
    get worktreeListCallCount() {
      return worktreeListCallCount;
    },
    get statusArgs() {
      return statusArgs;
    },
  };
});

it.effect("runs reservation, removal, restoration, and fresh report service flows", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const success = yield* makeHarness({ remove: "success" });
      const successService = yield* success.program;
      yield* successService.getReport;
      yield* successService.getReport;
      expect(success.worktreeListCallCount).toBe(2);
      const successResult = yield* successService.pruneStale;
      expect(successResult.removedCount).toBe(1);
      expect(success.threadPath).toBeNull();
      expect(success.removeCallCount).toBe(1);

      const failure = yield* makeHarness({ remove: "failure" });
      const failureService = yield* failure.program;
      const failureResult = yield* failureService.pruneStale;
      expect(failureResult.failedCount).toBe(1);
      expect(failure.threadPath).toBe(failure.candidatePath);
      expect(failure.removeCallCount).toBe(1);

      const mismatch = yield* makeHarness({
        remove: "success",
        rebindBeforeReservation: true,
      });
      const mismatchService = yield* mismatch.program;
      const mismatchResult = yield* mismatchService.pruneStale;
      expect(mismatchResult.removedCount).toBe(0);
      expect(mismatch.threadPath).toBe(mismatch.reboundPath);
      expect(mismatch.removeCallCount).toBe(0);
    }),
  ),
);

it.effect("labels scan-context failures with the requested operation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({ remove: "success", failProjectionLoad: true });
      const service = yield* harness.program;

      const reportError = yield* Effect.flip(service.getReport);
      expect(reportError.operation).toBe("report");

      const pruneError = yield* Effect.flip(service.pruneStale);
      expect(pruneError.operation).toBe("prune");
    }),
  ),
);

it.effect("protects ignored files from non-force worktree removal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({ remove: "success", statusStdout: "!! secret\n" });
      const service = yield* harness.program;

      const result = yield* service.pruneStale;

      expect(result.removedCount).toBe(0);
      expect(harness.removeCallCount).toBe(0);
      expect(harness.statusArgs).toContain("--ignored=matching");
    }),
  ),
);

it.effect("rechecks ignored files immediately before worktree removal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        remove: "success",
        statusStdouts: ["", "", "", "!! late-secret\n"],
      });
      const service = yield* harness.program;

      const result = yield* service.pruneStale;

      expect(result.removedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.outcomes[0]?.protectionReasons).toContain("dirty-or-untracked");
      expect(harness.removeCallCount).toBe(0);
      expect(harness.threadPath).toBe(harness.candidatePath);
    }),
  ),
);

it.effect("restores a reservation when pruning is interrupted during bounded removal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({ remove: "blocked-failure" });
      const service = yield* harness.program;
      const pruneFiber = yield* service.pruneStale.pipe(Effect.forkChild);
      yield* Deferred.await(harness.removeStarted);
      const interruptFiber = yield* Fiber.interrupt(pruneFiber).pipe(Effect.forkChild);
      yield* Deferred.succeed(harness.releaseRemove, undefined);
      yield* Fiber.join(interruptFiber);
      expect(harness.threadPath).toBe(harness.candidatePath);
      expect(harness.removeCallCount).toBe(1);
    }),
  ),
);

it.effect("continues restoring later reservations after an earlier restore defects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        remove: "failure",
        secondThread: true,
        defectOnFirstRestore: true,
      });
      const service = yield* harness.program;

      const result = yield* service.pruneStale;

      expect(result.failedCount).toBe(1);
      expect(result.errors.some((error) => error.operation === "restore-thread-worktree")).toBe(
        true,
      );
      expect(harness.threadPath).toBeNull();
      expect(harness.secondThreadPath).toBe(harness.candidatePath);
    }),
  ),
);

it.effect("restores earlier reservations when a later reservation defects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        remove: "success",
        secondThread: true,
        defectOnSecondClear: true,
      });
      const service = yield* harness.program;

      const result = yield* service.pruneStale;

      expect(result.removedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(harness.removeCallCount).toBe(0);
      expect(harness.threadPath).toBe(harness.candidatePath);
      expect(harness.secondThreadPath).toBe(harness.candidatePath);
    }),
  ),
);
