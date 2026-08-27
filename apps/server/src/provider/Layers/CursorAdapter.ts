/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP.
 *
 * @module CursorAdapterLive
 */

import {
  ApprovalRequestId,
  type CursorSettings,
  type ProviderOptionSelection,
  type ProviderInteractionMode,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
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
  makeAcpResumeCursorParser,
  mapAcpHandlerFailure,
  mapAcpToAdapterError,
  mcpServersForThread,
  resolveRequestedModeId,
} from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const isAcpError = Schema.is(EffectAcpErrors.AcpError);

const PROVIDER = ProviderDriverKind.make("cursor");
const CURSOR_RESUME_VERSION = 1 as const;

export interface CursorAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`cursor`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `cursorSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<CursorSettings>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CursorSessionContext extends AcpAdapterSessionContext {
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const pendingEntries = Array.from(pendingUserInputs.values());
    pendingUserInputs.clear();
    return Effect.forEach(
      pendingEntries,
      (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
      {
        discard: true,
      },
    );
  });
}

const parseCursorResume = makeAcpResumeCursorParser(CURSOR_RESUME_VERSION);

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cursor");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const core = yield* makeAcpAdapterCore<CursorSessionContext>({
      provider: PROVIDER,
      providerLabel: "Cursor",
      ...(options?.nativeEventLogPath !== undefined
        ? { nativeEventLogPath: options.nativeEventLogPath }
        : {}),
      ...(options?.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
      settlePendingInteractions: (ctx) =>
        settlePendingApprovalsAsCancelled(ctx.pendingApprovals).pipe(
          Effect.andThen(settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs)),
        ),
    });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      core.withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
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

          const cwd = path.resolve(input.cwd.trim());
          const cursorModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = core.sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* core.stopSessionInternal(existing);
          }

          const pendingApprovals: CursorSessionContext["pendingApprovals"] = new Map();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* core.openSessionScope;

          const resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = core.makeSessionNativeLoggers(input.threadId);

          // Resolve the CursorSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { cursor: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveCursorSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : cursorSettings;

          const mcpServers = mcpServersForThread(input.threadId);
          const acp = yield* makeCursorAcpRuntime({
            cursorSettings: effectiveCursorSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpServers ? { mcpServers } : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope.scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const resolveTurnId = () => core.sessions.get(input.threadId)?.activeTurnId;
          const started = yield* Effect.gen(function* () {
            yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
              mapAcpHandlerFailure("cursor/ask_question")(
                Effect.gen(function* () {
                  yield* core.logNative(input.threadId, "cursor/ask_question", params);
                  const requestId = ApprovalRequestId.make(yield* core.randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                  pendingUserInputs.set(requestId, { answers });
                  yield* core.offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* core.makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: resolveTurnId(),
                    requestId: runtimeRequestId,
                    payload: { questions: extractAskQuestions(params) },
                    raw: {
                      source: "acp.cursor.extension",
                      method: "cursor/ask_question",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(answers);
                  pendingUserInputs.delete(requestId);
                  yield* core.offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* core.makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: resolveTurnId(),
                    requestId: runtimeRequestId,
                    payload: { answers: resolved },
                  });
                  return { answers: resolved };
                }),
              ),
            );
            yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
              mapAcpHandlerFailure("cursor/create_plan")(
                Effect.gen(function* () {
                  yield* core.logNative(input.threadId, "cursor/create_plan", params);
                  yield* core.offerRuntimeEvent({
                    type: "turn.proposed.completed",
                    ...(yield* core.makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: resolveTurnId(),
                    payload: { planMarkdown: extractPlanMarkdown(params) },
                    raw: {
                      source: "acp.cursor.extension",
                      method: "cursor/create_plan",
                      payload: params,
                    },
                  });
                  return { accepted: true } as const;
                }),
              ),
            );
            yield* acp.handleExtNotification(
              "cursor/update_todos",
              CursorUpdateTodosRequest,
              (params) =>
                mapAcpHandlerFailure("cursor/update_todos")(
                  Effect.gen(function* () {
                    yield* core.logNative(input.threadId, "cursor/update_todos", params);
                    const ctx = core.sessions.get(input.threadId);
                    if (ctx) {
                      yield* core.emitPlanUpdate(ctx, {
                        turnId: ctx.activeTurnId,
                        payload: extractTodosAsPlan(params),
                        rawPayload: params,
                        source: "acp.cursor.extension",
                        method: "cursor/update_todos",
                      });
                    }
                  }),
                ),
            );
            yield* acp.handleRequestPermission(
              core.makePermissionRequestHandler({
                threadId: input.threadId,
                runtimeMode: input.runtimeMode,
                pendingApprovals,
                resolveTurnId,
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: cursorModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* core.nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: cursorModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CURSOR_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: CursorSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope.scope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
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
            resumePayload: started.initializeResult,
            providerThreadId: started.sessionId,
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        yield* core.requireSession(input.threadId);
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

        const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) {
          promptParts.push({ type: "text", text: input.input.trim() });
        }
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const resolveModel = (ctx: CursorSessionContext) =>
          turnModelSelection?.model ?? ctx.session.model;

        return yield* core.runReservedPrompt({
          threadId: input.threadId,
          prompt: ({ ctx, steeringTurnId, turnId }) => {
            const model = resolveModel(ctx);
            const resolvedModel = resolveCursorAcpBaseModelId(model);
            return ctx.acp
              .prompt(
                { prompt: promptParts },
                {
                  configureBeforePrompt: Effect.gen(function* () {
                    yield* applyRequestedSessionConfiguration({
                      runtime: ctx.acp,
                      runtimeMode: ctx.session.runtimeMode,
                      interactionMode: input.interactionMode,
                      modelSelection:
                        model === undefined
                          ? undefined
                          : {
                              model,
                              options: turnModelSelection?.options,
                            },
                      mapError: ({ cause, method }) =>
                        mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
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
                        payload: { model: resolvedModel },
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
          recordResult: ({ ctx, turnId }, result) =>
            Effect.gen(function* () {
              const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
              if (turnRecord) {
                turnRecord.items.push({ prompt: promptParts, result });
              } else {
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
              }
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                updatedAt: yield* core.nowIso,
                model: resolveCursorAcpBaseModelId(resolveModel(ctx)),
              };
            }),
        });
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = core.interruptActiveTurn;

    const respondToRequest: CursorAdapterShape["respondToRequest"] = core.respondToApproval;

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* core.requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* core.requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* core.requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
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
    } satisfies CursorAdapterShape;
  });
}
