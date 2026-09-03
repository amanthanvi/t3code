import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadTurnState,
} from "./Services/ProjectionSnapshotQuery.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";
const sourceThreadId = ThreadId.make("thread-source");
const sourceTurnId = TurnId.make("turn-source");
const sourceMessageId = MessageId.make("message-source");

const normalizerBaseLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-fork-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const normalizeFork = (sourceTurn: Option.Option<ProjectionThreadTurnState>) =>
  normalizeDispatchCommand({
    type: "thread.fork",
    commandId: CommandId.make("command-fork"),
    threadId: ThreadId.make("thread-fork"),
    sourceThreadId,
    sourceTurnId,
    sourceMessageId,
    sideChat: true,
    createdAt: "2026-09-03T12:00:00.000Z",
  }).pipe(
    Effect.provide(
      Layer.merge(
        normalizerBaseLayer,
        Layer.mock(ProjectionSnapshotQuery, {
          getThreadTurnState: () => Effect.succeed(sourceTurn),
        }),
      ),
    ),
  );

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand thread.fork", () => {
  effectIt.effect("rejects a nonexistent source turn", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(Option.none()).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("does not exist");
    }),
  );

  effectIt.effect("rejects an incomplete source turn", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(
        Option.some({ state: "running", assistantMessageId: null }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("not a completed turn");
    }),
  );

  effectIt.effect("rejects a source message that does not match the source turn", () =>
    Effect.gen(function* () {
      const error = yield* normalizeFork(
        Option.some({
          state: "completed",
          assistantMessageId: MessageId.make("message-other"),
        }),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("is not the assistant message");
    }),
  );
});
