/**
 * ClineAdapterLive — Cline CLI (`cline --acp`) via ACP.
 *
 * @module ClineAdapterLive
 */

import {
  ApprovalRequestId,
  type ClineSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyClineAcpModelSelection,
  CLINE_PROCESS_FORCE_KILL_AFTER,
  clineModelsFromSessionConfigOptions,
  currentClineModelIdFromSessionSetup,
  makeClineAcpRuntime,
  startClineAcpRuntimeWithTimeout,
} from "../acp/ClineAcpSupport.ts";
import { type ClineAdapterShape } from "../Services/ClineAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const isAcpError = Schema.is(EffectAcpErrors.AcpError);

const PROVIDER = ProviderDriverKind.make("cline");
const CLINE_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["act", "code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];
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

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

const mapHandlerFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed to process Cline ACP handler.",
          cause,
        }),
    ),
  );

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
  /** Test-only scheduling hook at the shared ACP prompt serialization boundary. */
  readonly beforePromptSerialization?: Effect.Effect<void>;
  /** Test-only scheduling hook before a send reserves its turn. */
  readonly beforeTurnReservation?: Effect.Effect<void>;
  /** Test-only scheduling hook inside the atomic prompt-settlement section. */
  readonly afterPromptSettlementDecision?: Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface ClineSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared. */
  promptsInFlight: number;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const pendingEntries = Array.from(pendingApprovals.values());
    pendingApprovals.clear();
    return Effect.forEach(
      pendingEntries,
      (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
      {
        discard: true,
      },
    );
  });
}

const decodeClineResumeExit = Schema.decodeUnknownExit(
  Schema.Struct({
    schemaVersion: Schema.Literal(CLINE_RESUME_VERSION),
    sessionId: Schema.String,
  }),
);

function parseClineResume(raw: unknown): { sessionId: string } | undefined {
  const decoded = decodeClineResumeExit(raw);
  if (Exit.isFailure(decoded)) return undefined;
  const sessionId = decoded.value.sessionId.trim();
  return sessionId.length > 0 ? { sessionId } : undefined;
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

interface ClineThreadLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

export interface ClineThreadLockPool {
  readonly withLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly size: Effect.Effect<number>;
}

/** A keyed mutex pool that retains keys only while holders or waiters exist. */
export const makeClineThreadLockPool = Effect.fn("makeClineThreadLockPool")(function* () {
  const locksRef = yield* SynchronizedRef.make(new Map<string, ClineThreadLockEntry>());

  const acquireLock = Effect.fn("clineThreadLockPool.acquireLock")(function* (threadId: string) {
    return yield* SynchronizedRef.modifyEffect(locksRef, (current) => {
      const existing = current.get(threadId);
      if (existing) {
        const next = new Map(current);
        next.set(threadId, { ...existing, users: existing.users + 1 });
        return Effect.succeed([existing.semaphore, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, { semaphore, users: 1 });
          return [semaphore, next] as const;
        }),
      );
    });
  });

  const releaseLock = Effect.fn("clineThreadLockPool.releaseLock")(function* (
    threadId: string,
    semaphore: Semaphore.Semaphore,
  ) {
    yield* SynchronizedRef.update(locksRef, (current) => {
      const existing = current.get(threadId);
      if (!existing || existing.semaphore !== semaphore) {
        return current;
      }
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(threadId);
      } else {
        next.set(threadId, { ...existing, users: existing.users - 1 });
      }
      return next;
    });
  });

  const withLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquireLock(threadId),
      (semaphore) => semaphore.withPermit(effect),
      (semaphore) => releaseLock(threadId, semaphore),
    );

  return {
    withLock,
    size: SynchronizedRef.get(locksRef).pipe(Effect.map((locks) => locks.size)),
  } satisfies ClineThreadLockPool;
});

export const makeClineAdapter = Effect.fn("makeClineAdapter")(function* (
  clineSettings: ClineSettings,
  options?: ClineAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cline");
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

  const sessions = new Map<ThreadId, ClineSessionContext>();
  const threadLocks = yield* makeClineThreadLockPool();
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Cline runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const withThreadLock = threadLocks.withLock;

  const logNative = Effect.fn("ClineAdapter.logNative")(function* (
    threadId: ThreadId,
    method: string,
    payload: unknown,
  ) {
    if (!nativeEventLogger) return;
    const observedAt = yield* nowIso;
    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: yield* randomUUIDv4,
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method,
          threadId,
          payload,
        },
      },
      threadId,
    );
  });

  const emitPlanUpdate = Effect.fn("ClineAdapter.emitPlanUpdate")(function* (
    ctx: ClineSessionContext,
    payload: {
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    },
    rawPayload: unknown,
    method: string,
  ) {
    const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
    if (ctx.lastPlanFingerprint === fingerprint) {
      return;
    }
    ctx.lastPlanFingerprint = fingerprint;
    yield* offerRuntimeEvent(
      makeAcpPlanUpdatedEvent({
        stamp: yield* makeEventStamp(),
        provider: PROVIDER,
        threadId: ctx.threadId,
        turnId: ctx.activeTurnId,
        payload,
        source: "acp.jsonrpc",
        method,
        rawPayload,
      }),
    );
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClineSessionContext, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(ctx);
  };

  const stopSessionInternal = Effect.fn("ClineAdapter.stopSessionInternal")(function* (
    ctx: ClineSessionContext,
  ) {
    if (ctx.stopped) return;
    ctx.stopped = true;
    yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
    if (ctx.notificationFiber) {
      yield* Fiber.interrupt(ctx.notificationFiber);
    }
    yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
    sessions.delete(ctx.threadId);
    yield* offerRuntimeEvent({
      type: "session.exited",
      ...(yield* makeEventStamp()),
      provider: PROVIDER,
      threadId: ctx.threadId,
      payload: { exitKind: "graceful" },
    });
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
    }).pipe(Effect.asVoid);

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
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
      return yield* withThreadLock(
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
                "Cline currently requires Full access because ACP loads executable workspace and account extensions outside T3's permission requests.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const clineModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: ClineSessionContext;

          const resumeSessionId = parseClineResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

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
            ...(options?.beforePromptSerialization
              ? { beforePromptSerialization: options.beforePromptSerialization }
              : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
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
            yield* acp.handleRequestPermission((params) =>
              mapHandlerFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  const permissionRequest = parsePermissionRequest(params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            const started = yield* startClineAcpRuntimeWithTimeout({
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
                ? "Cline ACP session/load replay became idle without returning model configuration. Resume cannot safely bind a model; retry after Cline finishes loading the session."
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

          const now = yield* nowIso;
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

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Cline runtime notification.", { cause }),
            ),
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: clineInitializeResultForSnapshot(started.initializeResult) },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cline ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );
    },
  );

  const sendTurn: ClineAdapterShape["sendTurn"] = Effect.fn("ClineAdapter.sendTurn")(
    function* (input) {
      yield* requireSession(input.threadId);
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
      yield* options?.beforeTurnReservation ?? Effect.void;
      const prepared = yield* withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          // Reserve the active turn before any provider/configuration yield.
          // Concurrent sends are steers and must observe the first send's id.
          const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
          const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
          ctx.promptsInFlight += 1;
          ctx.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          return { ctx, steeringTurnId, turnId };
        }),
      );
      const { ctx, steeringTurnId, turnId } = prepared;
      let promptReservationReleased = false;

      return yield* Effect.gen(function* () {
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const requestedTurnModel = turnModelSelection?.model.trim();
        const model = requestedTurnModel || ctx.session.model;
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [
          { type: "text", text: promptText },
        ];

        const result = yield* ctx.acp
          .prompt(
            { prompt: promptParts },
            Effect.gen(function* () {
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
                updatedAt: yield* nowIso,
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { model },
                });
              }
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              isAcpError(error)
                ? mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error)
                : error,
            ),
          );

        if (!ctx.turns.some((turn) => turn.id === turnId)) {
          // Cline remains the durable conversation owner. Keep only the
          // lightweight turn identity needed by this adapter's read shape;
          // retaining prompt bodies here would duplicate unbounded history.
          ctx.turns.push({ id: turnId, items: [] });
        }
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          model,
        };

        // Decide completion and release the prompt reservation under the same
        // thread lock used by new sends. A send either joins this turn before
        // the decision or starts a new turn after its completion is published.
        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            promptReservationReleased = true;
            const shouldCompleteTurn = ctx.promptsInFlight === 0;
            yield* options?.afterPromptSettlementDecision ?? Effect.void;
            if (shouldCompleteTurn) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: result.stopReason ?? null,
                },
              });
            }
          }),
        ).pipe(Effect.uninterruptible);

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            promptReservationReleased
              ? Effect.void
              : withThreadLock(
                  input.threadId,
                  Effect.sync(() => {
                    ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
                    promptReservationReleased = true;
                  }),
                ),
          ),
        ),
      );
    },
  );

  const interruptTurn: ClineAdapterShape["interruptTurn"] = Effect.fn("ClineAdapter.interruptTurn")(
    function* (threadId) {
      const ctx = yield* requireSession(threadId);
      yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
      yield* Effect.ignore(
        ctx.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
          ),
        ),
      );
    },
  );

  const respondToRequest: ClineAdapterShape["respondToRequest"] = Effect.fn(
    "ClineAdapter.respondToRequest",
  )(function* (threadId, requestId, decision) {
    const ctx = yield* requireSession(threadId);
    const pending = ctx.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/request_permission",
        detail: `Unknown pending approval request: ${requestId}`,
      });
    }
    ctx.pendingApprovals.delete(requestId);
    const settled = yield* Deferred.succeed(pending.decision, decision);
    if (!settled) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/request_permission",
        detail: `Approval request was already resolved: ${requestId}`,
      });
    }
  });

  const respondToUserInput: ClineAdapterShape["respondToUserInput"] = Effect.fn(
    "ClineAdapter.respondToUserInput",
  )(function* (threadId, requestId) {
    yield* requireSession(threadId);
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "user-input",
      detail: `Cline ACP has no pending structured user-input request: ${requestId}`,
    });
  });

  const readThread: ClineAdapterShape["readThread"] = Effect.fn("ClineAdapter.readThread")(
    function* (threadId) {
      const ctx = yield* requireSession(threadId);
      return { threadId, turns: ctx.turns };
    },
  );

  const rollbackThread: ClineAdapterShape["rollbackThread"] = Effect.fn(
    "ClineAdapter.rollbackThread",
  )(function* (threadId, numTurns) {
    yield* requireSession(threadId);
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

  const stopSession: ClineAdapterShape["stopSession"] = Effect.fn("ClineAdapter.stopSession")(
    function* (threadId) {
      yield* withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );
    },
  );

  const listSessions: ClineAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

  const hasSession: ClineAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const c = sessions.get(threadId);
      return c !== undefined && !c.stopped;
    });

  const stopAll: ClineAdapterShape["stopAll"] = () =>
    Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Failed to emit Cline session shutdown event.", { cause }),
      ),
      Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

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
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents,
  } satisfies ClineAdapterShape;
});
