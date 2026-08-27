/**
 * ClineAdapterLive — Cline CLI (`cline --acp`) via ACP.
 *
 * @module ClineAdapterLive
 */

import {
  type ClineSettings,
  type ProviderInteractionMode,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Crypto from "effect/Crypto";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  makeAcpAdapterCore,
  settlePendingApprovalsAsCancelled,
  type AcpAdapterSessionContext,
} from "../acp/AcpAdapterCore.ts";
import {
  ACP_IMPLEMENT_MODE_ALIASES,
  makeAcpResumeCursorParser,
  mapAcpToAdapterError,
  resolveRequestedModeId,
} from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { startAcpRuntimeWithTimeout } from "../acp/AcpSessionRuntime.ts";
import {
  applyClineAcpModelSelection,
  CLINE_PROCESS_FORCE_KILL_AFTER,
  clineModelsFromSessionConfigOptions,
  currentClineModelIdFromSessionSetup,
  makeClineAcpRuntime,
} from "../acp/ClineAcpSupport.ts";
import { type ClineAdapterShape } from "../Services/ClineAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

const PROVIDER = ProviderDriverKind.make("cline");
const CLINE_RESUME_VERSION = 1 as const;
const CLINE_IMPLEMENT_MODE_ALIASES = ["act", ...ACP_IMPLEMENT_MODE_ALIASES];
const CLINE_SESSION_START_TIMEOUT = "30 seconds";

function clineInitializeResultForSnapshot(
  result: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.InitializeResponse {
  return {
    ...result,
    agentCapabilities: {
      ...result.agentCapabilities,
      promptCapabilities: {
        ...result.agentCapabilities?.promptCapabilities,
        // Current Cline advertises image prompts but filters every non-text
        // block before dispatch. Keep the T3 snapshot truthful until the CLI
        // actually consumes ACP image blocks.
        image: false,
      },
    },
  };
}

export interface ClineAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`cline`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `clineSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight pass a resolver
   * that reads the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<ClineSettings>;
  /** Override only for deterministic startup timeout tests. */
  readonly sessionStartTimeout?: Duration.Input;
  /** Test-only scheduling hooks; production callers leave this unset. */
  readonly testHooks?: {
    /** Scheduling hook at the shared ACP prompt serialization boundary. */
    readonly beforePromptSerialization?: Effect.Effect<void>;
    /** Scheduling hook before a send reserves its turn. */
    readonly beforeTurnReservation?: Effect.Effect<void>;
    /** Scheduling hook inside the atomic prompt-settlement section. */
    readonly afterPromptSettlementDecision?: Effect.Effect<void>;
  };
}

interface ClineSessionContext extends AcpAdapterSessionContext {}

const parseClineResume = makeAcpResumeCursorParser(CLINE_RESUME_VERSION);

export const makeClineAdapter = Effect.fn("makeClineAdapter")(function* (
  clineSettings: ClineSettings,
  options?: ClineAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cline");
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const core = yield* makeAcpAdapterCore<ClineSessionContext>({
    provider: PROVIDER,
    providerLabel: "Cline",
    ...(options?.nativeEventLogPath !== undefined
      ? { nativeEventLogPath: options.nativeEventLogPath }
      : {}),
    ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
    settlePendingInteractions: (ctx) => settlePendingApprovalsAsCancelled(ctx.pendingApprovals),
    ...(options?.testHooks
      ? {
          testHooks: {
            ...(options.testHooks.beforeTurnReservation
              ? { beforeTurnReservation: options.testHooks.beforeTurnReservation }
              : {}),
            ...(options.testHooks.afterPromptSettlementDecision
              ? {
                  afterPromptSettlementDecision: options.testHooks.afterPromptSettlementDecision,
                }
              : {}),
          },
        }
      : {}),
  });

  const applyRequestedSessionConfiguration = Effect.fn(
    "ClineAdapter.applyRequestedSessionConfiguration",
  )(function* (input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly threadId: ThreadId;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode | undefined;
    readonly requestedModelId: string | undefined;
  }) {
    yield* applyClineAcpModelSelection({
      runtime: input.runtime,
      requestedModelId: input.requestedModelId,
      mapError: (cause) =>
        mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
    });

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
      implementModeAliases: CLINE_IMPLEMENT_MODE_ALIASES,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime
      .setMode(requestedModeId)
      .pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
        ),
      );
  });

  const startSession: ClineAdapterShape["startSession"] = Effect.fn("ClineAdapter.startSession")(
    function* (input) {
      return yield* core.withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          if (input.runtimeMode !== "full-access") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "Cline requires Full access: its extensions can run commands that T3's permission prompts don't cover.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const clineModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = core.sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* core.stopSessionInternal(existing);
          }

          const pendingApprovals: ClineSessionContext["pendingApprovals"] = new Map();
          const sessionScope = yield* core.openSessionScope;

          const resumeSessionId = parseClineResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = core.makeSessionNativeLoggers(input.threadId);

          const effectiveClineSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : clineSettings;

          const acp = yield* makeClineAcpRuntime({
            clineSettings: effectiveClineSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            forceKillAfter: CLINE_PROCESS_FORCE_KILL_AFTER,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(options?.testHooks?.beforePromptSerialization
              ? {
                  testHooks: {
                    beforePromptSerialization: options.testHooks.beforePromptSerialization,
                  },
                }
              : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope.scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to create Cline ACP runtime.",
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission(
              core.makePermissionRequestHandler({
                threadId: input.threadId,
                runtimeMode: input.runtimeMode,
                pendingApprovals,
                resolveTurnId: () => core.sessions.get(input.threadId)?.activeTurnId,
              }),
            );
            const started = yield* startAcpRuntimeWithTimeout({
              runtime: acp,
              timeout: options?.sessionStartTimeout ?? CLINE_SESSION_START_TIMEOUT,
              forceKillAfter: CLINE_PROCESS_FORCE_KILL_AFTER,
            }).pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );
            if (Option.isNone(started)) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail:
                  "Cline ACP session startup timed out. Check the Cline CLI configuration and try again.",
              });
            }
            return started.value;
          });

          if (clineModelsFromSessionConfigOptions(started.sessionSetupResult).length === 0) {
            const replayIdleWithoutConfig =
              started.sessionSetupResult._meta?.t3SessionLoadReady === "replay_idle";
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: replayIdleWithoutConfig
                ? "Cline did not return its model list while resuming this session. Wait for Cline to finish loading, then retry."
                : "Cline ACP did not advertise any usable models. Configure a provider and model in Cline, then start a new session.",
            });
          }

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            requestedModelId: clineModelSelection?.model,
          });

          const requestedSessionModel = clineModelSelection?.model.trim();
          const sessionModel =
            requestedSessionModel ||
            currentClineModelIdFromSessionSetup(started.sessionSetupResult);

          const now = yield* core.nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: sessionModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CLINE_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: ClineSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope.scope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            stopped: false,
          };

          yield* core.attachSession({
            ctx,
            notificationFiber: yield* core.runSessionEventLoop(ctx),
            markScopeTransferred: sessionScope.markTransferred,
            resumePayload: clineInitializeResultForSnapshot(started.initializeResult),
            providerThreadId: started.sessionId,
          });

          return session;
        }).pipe(Effect.scoped),
      );
    },
  );

  const sendTurn: ClineAdapterShape["sendTurn"] = Effect.fn("ClineAdapter.sendTurn")(
    function* (input) {
      yield* core.requireSession(input.threadId);
      if (input.interactionMode === "plan") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue:
            "Cline Plan mode is unavailable because ACP loads executable workspace and account extensions outside T3's permission requests.",
        });
      }
      if (input.attachments && input.attachments.length > 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Cline CLI currently does not accept image attachments over ACP.",
        });
      }
      const promptText = input.input?.trim();
      if (!promptText) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires non-empty text.",
        });
      }

      const turnModelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const requestedTurnModel = turnModelSelection?.model.trim();
      const resolveModel = (ctx: ClineSessionContext) => requestedTurnModel || ctx.session.model;

      return yield* core.runReservedPrompt({
        threadId: input.threadId,
        prompt: ({ ctx, steeringTurnId, turnId }) => {
          const model = resolveModel(ctx);
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [
            { type: "text", text: promptText },
          ];
          return ctx.acp
            .prompt(
              { prompt: promptParts },
              {
                configureBeforePrompt: Effect.gen(function* () {
                  yield* applyRequestedSessionConfiguration({
                    runtime: ctx.acp,
                    threadId: input.threadId,
                    runtimeMode: ctx.session.runtimeMode,
                    interactionMode: input.interactionMode,
                    requestedModelId: model,
                  });
                  ctx.session = {
                    ...ctx.session,
                    activeTurnId: turnId,
                    updatedAt: yield* core.nowIso,
                  };

                  if (steeringTurnId === undefined) {
                    yield* core.offerRuntimeEvent({
                      type: "turn.started",
                      ...(yield* core.makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      payload: { model },
                    });
                  }
                }),
              },
            )
            .pipe(
              Effect.mapError((error) =>
                isAcpError(error)
                  ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error)
                  : error,
              ),
            );
        },
        recordResult: ({ ctx, turnId }) =>
          Effect.gen(function* () {
            if (!ctx.turns.some((turn) => turn.id === turnId)) {
              // Cline remains the durable conversation owner. Keep only the
              // lightweight turn identity needed by this adapter's read shape;
              // retaining prompt bodies here would duplicate unbounded history.
              ctx.turns.push({ id: turnId, items: [] });
            }
            ctx.session = {
              ...ctx.session,
              activeTurnId: turnId,
              updatedAt: yield* core.nowIso,
              model: resolveModel(ctx),
            };
          }),
      });
    },
  );

  const interruptTurn: ClineAdapterShape["interruptTurn"] = Effect.fn("ClineAdapter.interruptTurn")(
    function* (threadId) {
      yield* core.interruptActiveTurn(threadId);
    },
  );

  const respondToRequest: ClineAdapterShape["respondToRequest"] = core.respondToApproval;

  const respondToUserInput: ClineAdapterShape["respondToUserInput"] = Effect.fn(
    "ClineAdapter.respondToUserInput",
  )(function* (threadId, requestId) {
    yield* core.requireSession(threadId);
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "user-input",
      detail: `Cline ACP has no pending structured user-input request: ${requestId}`,
    });
  });

  const readThread: ClineAdapterShape["readThread"] = Effect.fn("ClineAdapter.readThread")(
    function* (threadId) {
      const ctx = yield* core.requireSession(threadId);
      return { threadId, turns: ctx.turns };
    },
  );

  const rollbackThread: ClineAdapterShape["rollbackThread"] = Effect.fn(
    "ClineAdapter.rollbackThread",
  )(function* (threadId, numTurns) {
    yield* core.requireSession(threadId);
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "numTurns must be an integer >= 1.",
      });
    }
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "thread/rollback",
      detail: "Cline ACP sessions do not support provider-side rollback yet.",
    });
  });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession: core.stopSession,
    listSessions: core.listSessions,
    hasSession: core.hasSession,
    stopAll: core.stopAll,
    streamEvents: core.streamEvents,
  } satisfies ClineAdapterShape;
});
