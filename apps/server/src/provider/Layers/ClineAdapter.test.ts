// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  ClineSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  type ClineAdapterLiveOptions,
  makeClineAdapter,
  makeClineThreadLockPool,
} from "./ClineAdapter.ts";
const decodeClineSettings = Schema.decodeSync(ClineSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockClineWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-cline.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const clineAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-cline-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  binaryPath: string,
  options?: Pick<ClineAdapterLiveOptions, "sessionStartTimeout">,
) => makeClineAdapter(decodeClineSettings({ binaryPath }), options).pipe(Effect.orDie);

it.effect("releases Cline thread locks after serialized work and thread churn", () =>
  Effect.gen(function* () {
    const locks = yield* makeClineThreadLockPool();
    const active = yield* Ref.make(0);
    const maximumActive = yield* Ref.make(0);
    const criticalSection = Effect.gen(function* () {
      const activeNow = yield* Ref.updateAndGet(active, (value) => value + 1);
      yield* Ref.update(maximumActive, (value) => Math.max(value, activeNow));
      yield* Effect.yieldNow;
      yield* Ref.update(active, (value) => value - 1);
    });

    yield* Effect.all(
      Array.from({ length: 32 }, () => locks.withLock("shared", criticalSection)),
      { concurrency: "unbounded", discard: true },
    );
    assert.equal(yield* Ref.get(maximumActive), 1);
    assert.equal(yield* locks.size, 0);

    yield* Effect.forEach(
      Array.from({ length: 100 }, (_, index) => `thread-${index}`),
      (threadId) => locks.withLock(threadId, Effect.void),
      { discard: true },
    );
    assert.equal(yield* locks.size, 0);
  }),
);

it.layer(clineAdapterTestLayer)("ClineAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-mock-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_ADVERTISE_IMAGE_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "cline");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.equal(session.model, "default");

      yield* adapter.sendTurn({
        threadId,
        input: "hello cline",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const sessionStarted = runtimeEvents.find((event) => event.type === "session.started");
      assert.isDefined(sessionStarted);
      if (sessionStarted?.type === "session.started") {
        const resume = sessionStarted.payload.resume as {
          readonly agentCapabilities?: {
            readonly promptCapabilities?: { readonly image?: boolean };
          };
        };
        assert.isFalse(resume.agentCapabilities?.promptCapabilities?.image);
      }

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      const turnStarted = runtimeEvents.find((event) => event.type === "turn.started");
      assert.isDefined(turnStarted);
      if (turnStarted?.type === "turn.started") {
        assert.equal(turnStarted.payload.model, "default");
      }
      assert.equal((yield* adapter.listSessions())[0]?.model, "default");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes the exact Cline ACP session through session/load", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-resume-session");
      const sessionId = "cline-existing-session";
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId },
      });
      yield* adapter.stopSession(threadId);

      assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId });
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const sessionLoad = requests.find((entry) => entry.method === "session/load");
      assert.isDefined(sessionLoad);
      assert.equal(
        (sessionLoad?.params as { readonly sessionId?: unknown } | undefined)?.sessionId,
        sessionId,
      );
      assert.isFalse(requests.some((entry) => entry.method === "session/new"));
    }),
  );

  it.effect("rejects mixed and image-only turns before prompting Cline ACP", () =>
    Effect.forEach(
      [
        { label: "mixed", input: "describe this image" },
        { label: "image-only", input: "" },
      ],
      ({ label, input }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`cline-${label}-attachment`);
          const tempDir = yield* Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-image-rejection-")),
          );
          const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
          const wrapperPath = yield* Effect.promise(() =>
            makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
          );
          const adapter = yield* makeTestAdapter(wrapperPath);

          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("cline"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const error = yield* Effect.flip(
            adapter.sendTurn({
              threadId,
              input,
              attachments: [
                {
                  type: "image",
                  id: `${label}-image`,
                  name: "example.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
              ],
            }),
          );

          assert.equal(error._tag, "ProviderAdapterValidationError");
          if (error._tag === "ProviderAdapterValidationError") {
            assert.equal(
              error.issue,
              "Cline CLI currently does not accept image attachments over ACP.",
            );
          }

          yield* adapter.stopSession(threadId);
          const logged = yield* Effect.promise(() => readJsonLines(requestLogPath));
          assert.isFalse(logged.some((entry) => entry.method === "session/prompt"));
        }),
      { discard: true },
    ),
  );

  it.effect("rejects whitespace before mutating turn state or prompting Cline ACP", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-whitespace-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-whitespace-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "  \n\t ",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("cline"),
            model: "composer-2",
          },
        }),
      );
      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "turn.started" || event.type === "turn.completed",
        ),
      );
      const logged = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(logged.some((entry) => entry.method === "session/prompt"));
      assert.isFalse(
        logged.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as { readonly value?: unknown }).value === "composer-2",
        ),
      );
    }),
  );

  it.effect("rejects an empty Cline model catalog before setting a model or prompting", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-empty-model-catalog");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-empty-models-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_EMPTY_MODEL_CATALOG: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cline"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cline"),
            model: "gpt-5.6-sol",
          },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.include(error.issue, "did not advertise any usable models");
      }
      const logged = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(logged.some((entry) => entry.method === "session/set_config_option"));
      assert.isFalse(logged.some((entry) => entry.method === "session/prompt"));
    }),
  );

  it.effect("rejects non-full-access modes before spawning Cline ACP", () =>
    Effect.forEach(
      ["approval-required", "auto-accept-edits", "auto"] as const,
      (runtimeMode) =>
        Effect.gen(function* () {
          const adapter = yield* makeTestAdapter("/definitely/missing/cline");
          const error = yield* Effect.flip(
            adapter.startSession({
              threadId: ThreadId.make(`cline-unsupported-mode-${runtimeMode}`),
              provider: ProviderDriverKind.make("cline"),
              cwd: process.cwd(),
              runtimeMode,
            }),
          );

          assert.equal(error._tag, "ProviderAdapterValidationError");
          if (error._tag === "ProviderAdapterValidationError") {
            assert.include(error.issue, "requires Full access");
          }
        }),
      { discard: true },
    ),
  );

  it.effect("times out a hung ACP startup and force-closes its child", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-hung-startup");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-hung-startup-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
          T3_ACP_HANG_INITIALIZE_FOREVER: "1",
          T3_ACP_IGNORE_SIGTERM: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, { sessionStartTimeout: "500 millis" });

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cline"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterProcessError");
      if (error._tag === "ProviderAdapterProcessError") {
        assert.include(error.detail, "startup timed out");
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.include(yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8")), "SIGTERM");
    }).pipe(TestClock.withLive),
  );

  it.effect("selects models through ACP config options on start and steer", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-model-config-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-request-log-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.jsonl");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cline"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "switch models mid-thread",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("cline"),
          model: "composer-2[fast=true]",
        },
      });

      // The mock resolves prompts immediately; stopping the session gives a
      // deterministic observation point before reading what the mock logged.
      yield* adapter.stopSession(threadId);

      const logged = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(logged.some((entry) => entry.method === "authenticate"));
      const sessionNew = logged.find((entry) => entry.method === "session/new");
      assert.deepStrictEqual(
        (sessionNew?.params as { readonly mcpServers?: ReadonlyArray<unknown> } | undefined)
          ?.mcpServers,
        [],
      );
      const setConfigRequests = logged
        .filter((entry) => entry.method === "session/set_config_option")
        .map((entry) => entry.params as Record<string, unknown>);

      // Model writes happen at session start and again when the steer lands;
      // the adapter may interleave a mode write between them.
      assert.deepStrictEqual(
        setConfigRequests
          .filter((params) => params.configId === "model")
          .map((params) => params.value),
        ["composer-2", "composer-2[fast=true]"],
      );

      const modeRequests = setConfigRequests.filter((params) => params.configId === "mode");
      assert.isTrue(modeRequests.every((request) => request.value !== "plan"));
    }),
  );

  it.effect("does not retain prompt bodies in the adapter thread snapshot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-lightweight-thread-snapshot");
      const wrapperPath = yield* Effect.promise(() => makeMockClineWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const privatePrompt = `private-marker-${"x".repeat(100_000)}`;

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: privatePrompt,
        attachments: [],
      });

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual(snapshot.turns[0]?.items, []);
    }),
  );

  it.effect("rejects Plan mode before mutating turn state or prompting Cline", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-plan-mode-rejected");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-plan-mode-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "plan this change",
          attachments: [],
          interactionMode: "plan",
        }),
      );
      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.include(error.issue, "Plan mode is unavailable");
      }

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);
      assert.isFalse(runtimeEvents.some((event) => event.type === "turn.started"));
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(requests.some((entry) => entry.method === "session/prompt"));
    }),
  );

  it.effect("rejects an explicit model outside Cline's advertised catalog before RPC", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-invalid-explicit-model");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-invalid-model-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cline"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cline"),
            model: "cline/retired-model",
          },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.include(error.detail, "Invalid value");
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(requests.some((entry) => entry.method === "session/set_config_option"));
    }),
  );

  it.effect("auto-approves tool permissions in full-access mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-full-access-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run it", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const approvalOpened = runtimeEvents.some((e) => e.type === "request.opened");
      assert.isFalse(approvalOpened);
      const completed = runtimeEvents.find((e) => e.type === "turn.completed");
      if (completed?.type !== "turn.completed") {
        return assert.fail("expected a turn.completed runtime event");
      }
      assert.equal(completed.payload.state, "completed");
    }),
  );

  it.effect("accepts only the first response to a pending approval", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-first-approval-response");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_NO_ALLOW_OPTIONS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      let duplicateErrorTag: string | undefined;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type !== "request.opened") return;
          const requestId = ApprovalRequestId.make(String(event.requestId));
          yield* adapter.respondToRequest(threadId, requestId, "accept");
          const duplicateError = yield* Effect.flip(
            adapter.respondToRequest(threadId, requestId, "cancel"),
          );
          duplicateErrorTag = duplicateError._tag;
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "approve once", attachments: [] });

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);
      assert.equal(duplicateErrorTag, "ProviderAdapterRequestError");
    }),
  );

  it.effect("rejects an approval response after interruption has cancelled it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-late-approval-response");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_NO_ALLOW_OPTIONS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      let lateErrorTag: string | undefined;
      const lateResponseChecked = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type !== "request.opened") return;
          const requestId = ApprovalRequestId.make(String(event.requestId));
          yield* adapter.interruptTurn(threadId);
          const lateError = yield* Effect.flip(
            adapter.respondToRequest(threadId, requestId, "accept"),
          );
          lateErrorTag = lateError._tag;
          yield* Deferred.succeed(lateResponseChecked, undefined);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "interrupt approval", attachments: [] });
      yield* Deferred.await(lateResponseChecked);

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);
      assert.equal(lateErrorTag, "ProviderAdapterRequestError");
    }),
  );

  it.effect("rejects structured user input because Cline ACP does not request it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-no-structured-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockClineWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const error = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("unknown-user-input"), {}),
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.include(error.detail, "no pending structured user-input request");
      }
    }),
  );

  it.effect("cancels an already queued steer without sending a late prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-cancel-queued-steer");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-cancel-queued-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstPromptStarted = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "content.delta" && event.payload.delta === "first prompt started") {
            yield* Deferred.succeed(firstPromptStarted, undefined);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstPromptStarted);

      const queuedTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "queued steer", attachments: [] })
        .pipe(Effect.forkChild);
      // Give the queued turn a scheduler turn so it reaches the runtime's
      // prompt semaphore before cancellation advances the generation.
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(firstTurnFiber);
      yield* Fiber.join(queuedTurnFiber);
      yield* Deferred.await(turnCompleted);

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.lengthOf(
        requests.filter((entry) => entry.method === "session/prompt"),
        1,
      );
      const completed = runtimeEvents.filter((event) => event.type === "turn.completed");
      assert.lengthOf(completed, 1);
      if (completed[0]?.type === "turn.completed") {
        assert.equal(completed[0].payload.state, "cancelled");
      }
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));

      const exitLog = yield* Effect.tryPromise(() => NodeFSP.readFile(exitLogPath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      assert.include(exitLog, "exit:");
    }),
  );

  it.effect("force-kills an ACP child that ignores TERM during session stop", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-stop-session-force-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-adapter-force-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
          T3_ACP_IGNORE_SIGTERM: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      assert.isFalse(yield* adapter.hasSession(threadId));
      assert.include(yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8")), "SIGTERM");
    }),
  );

  it.effect("reports rollback as unsupported instead of mutating only T3's local view", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-rollback-unsupported");
      const wrapperPath = yield* Effect.promise(() => makeMockClineWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const error = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.include(error.detail, "do not support provider-side rollback");
      }

      yield* adapter.stopSession(threadId);
    }),
  );
});
