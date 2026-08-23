import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(worktreePath: string | null): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: "settled",
        settledAt: NOW,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread worktree path compare-and-set", (it) => {
  it.effect("clears the path when the expected value still matches", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-clear-worktree"),
          threadId: ThreadId.make("thread-1"),
          worktreePath: null,
          expectedWorktreePath: "/managed/old",
        },
        readModel: makeReadModel("/managed/old"),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.worktreePath).toBeNull();
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("does not clear a path that was rebound before the metadata update", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-raced-clear-worktree"),
          threadId: ThreadId.make("thread-1"),
          worktreePath: null,
          expectedWorktreePath: "/managed/old",
        },
        readModel: makeReadModel("/managed/rebound"),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload).not.toHaveProperty("worktreePath");
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("restores a reservation only while the path remains null", () =>
    Effect.gen(function* () {
      const restore = (currentPath: string | null) =>
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make(`cmd-restore-${currentPath ?? "null"}`),
            threadId: ThreadId.make("thread-1"),
            worktreePath: "/managed/old",
            expectedWorktreePath: null,
          },
          readModel: makeReadModel(currentPath),
        });

      const fromNull = yield* restore(null);
      const nullEvents = Array.isArray(fromNull) ? fromNull : [fromNull];
      if (nullEvents[0]?.type === "thread.meta-updated") {
        expect(nullEvents[0].payload.worktreePath).toBe("/managed/old");
        expect(nullEvents[0].payload.updatedAt).toBe(NOW);
      }

      const fromRebound = yield* restore("/managed/new");
      const reboundEvents = Array.isArray(fromRebound) ? fromRebound : [fromRebound];
      if (reboundEvents[0]?.type === "thread.meta-updated") {
        expect(reboundEvents[0].payload).not.toHaveProperty("worktreePath");
      }
    }),
  );

  it.effect("continues to advance activity for ordinary metadata updates", () =>
    Effect.gen(function* () {
      const decide = (withExpectedPath: boolean) =>
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make(
              withExpectedPath ? "cmd-combined-meta-update" : "cmd-ordinary-meta-update",
            ),
            threadId: ThreadId.make("thread-1"),
            title: "Renamed",
            ...(withExpectedPath
              ? { worktreePath: null, expectedWorktreePath: "/managed/old" }
              : {}),
          },
          readModel: makeReadModel("/managed/old"),
        });
      const event = yield* decide(false);
      const combinedEvent = yield* decide(true);
      for (const decided of [event, combinedEvent]) {
        const events = Array.isArray(decided) ? decided : [decided];
        if (events[0]?.type === "thread.meta-updated") {
          expect(events[0].payload.updatedAt).not.toBe(NOW);
        }
      }
    }),
  );
});
