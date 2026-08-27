/**
 * Shared runtime plumbing for ACP-backed provider adapters.
 *
 * One adapter instance creates one core. The core owns the session map, the
 * runtime event pubsub, per-thread locks, native event logging, the
 * permission-request handler flow, the session event drain loop, and the
 * turn reservation/settlement policy. Adapters keep only provider-specific
 * behavior: spawn configuration, capability validation, prompt-part building,
 * provider extensions, and snapshot fixups.
 *
 * @module AcpAdapterCore
 */

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import {
  encodeJsonStringForDiagnostics,
  mapAcpHandlerFailure,
  selectAutoApprovedPermissionOption,
  selectPermissionOptionId,
} from "./AcpAdapterSupport.ts";
import {
  type AcpAdapterRawSource,
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";
import { makeKeyedLockPool } from "./AcpKeyedLockPool.ts";
import { makeAcpNativeLoggerFactory } from "./AcpNativeLogging.ts";
import { type AcpPlanUpdate, parsePermissionRequest } from "./AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export interface AcpPendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

export interface AcpAdapterSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, AcpPendingApproval>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared. */
  promptsInFlight: number;
  stopped: boolean;
}

export interface AcpTurnReservation<Ctx> {
  readonly ctx: Ctx;
  readonly turnId: TurnId;
  /** Set when this send joined an already running turn instead of opening one. */
  readonly steeringTurnId: TurnId | undefined;
}

export interface AcpAdapterCoreOptions<Ctx> {
  readonly provider: ProviderDriverKind;
  /** Human-facing provider name used in diagnostics ("Cline", "Cursor", "Grok"). */
  readonly providerLabel: string;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Settles every pending interactive request (approvals, user inputs) as
   * cancelled. Runs on interrupt and on session stop.
   */
  readonly settlePendingInteractions: (ctx: Ctx) => Effect.Effect<void>;
  /** Test-only scheduling hooks; production callers leave this unset. */
  readonly testHooks?: {
    /** Scheduling hook before a send reserves its turn. */
    readonly beforeTurnReservation?: Effect.Effect<void>;
    /** Scheduling hook inside the atomic prompt-settlement section. */
    readonly afterPromptSettlementDecision?: Effect.Effect<void>;
  };
}

export function settlePendingApprovalsAsCancelled(
  pendingApprovals: Map<ApprovalRequestId, AcpPendingApproval>,
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

export const makeAcpAdapterCore = Effect.fn("makeAcpAdapterCore")(function* <
  Ctx extends AcpAdapterSessionContext,
>(options: AcpAdapterCoreOptions<Ctx>) {
  const provider = options.provider;
  const crypto = yield* Crypto.Crypto;
  const nativeEventLogger =
    options.nativeEventLogger ??
    (options.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);
  const managedNativeEventLogger =
    options.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

  const sessions = new Map<ThreadId, Ctx>();
  const threadLocks = yield* makeKeyedLockPool();
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider,
          method: "crypto/randomUUIDv4",
          detail: `Failed to generate ${options.providerLabel} runtime identifier.`,
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const withThreadLock = threadLocks.withLock;

  const makeSessionNativeLoggers = (threadId: ThreadId) =>
    makeAcpNativeLoggers({ nativeEventLogger, provider, threadId });

  const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
    Effect.gen(function* () {
      if (!nativeEventLogger) return;
      const observedAt = yield* nowIso;
      yield* nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* randomUUIDv4,
            kind: "notification",
            provider,
            createdAt: observedAt,
            method,
            threadId,
            payload,
          },
        },
        threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Failed to write native ${options.providerLabel} notification log.`, {
          cause,
          threadId,
          method,
        }),
      ),
    );

  const emitPlanUpdate = (
    ctx: Ctx,
    input: {
      readonly turnId: TurnId | undefined;
      readonly payload: AcpPlanUpdate;
      readonly rawPayload: unknown;
      readonly source: AcpAdapterRawSource;
      readonly method: string;
    },
  ) =>
    Effect.gen(function* () {
      const fingerprint = `${input.turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(input.payload) ?? "[unserializable payload]"}`;
      if (ctx.lastPlanFingerprint === fingerprint) {
        return;
      }
      ctx.lastPlanFingerprint = fingerprint;
      yield* offerRuntimeEvent(
        makeAcpPlanUpdatedEvent({
          stamp: yield* makeEventStamp(),
          provider,
          threadId: ctx.threadId,
          turnId: input.turnId,
          payload: input.payload,
          source: input.source,
          method: input.method,
          rawPayload: input.rawPayload,
        }),
      );
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<Ctx, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    }
    return Effect.succeed(ctx);
  };

  const stopSessionInternal = Effect.fn("AcpAdapterCore.stopSessionInternal")(function* (ctx: Ctx) {
    if (ctx.stopped) return;
    ctx.stopped = true;
    yield* options.settlePendingInteractions(ctx);
    if (ctx.notificationFiber) {
      yield* Fiber.interrupt(ctx.notificationFiber);
    }
    yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
    sessions.delete(ctx.threadId);
    yield* offerRuntimeEvent({
      type: "session.exited",
      ...(yield* makeEventStamp()),
      provider,
      threadId: ctx.threadId,
      payload: { exitKind: "graceful" },
    });
  });

  const stopSession = (threadId: ThreadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      }),
    );

  const listSessions = () =>
    Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

  const hasSession = (threadId: ThreadId) =>
    Effect.sync(() => {
      const c = sessions.get(threadId);
      return c !== undefined && !c.stopped;
    });

  const stopAll = () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
      Effect.catch((cause) =>
        Effect.logError(`Failed to emit ${options.providerLabel} session shutdown event.`, {
          cause,
        }),
      ),
      Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
    ),
  );

  const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

  /**
   * A per-session scope whose ownership transfers to the session context once
   * the session is attached; until then the surrounding scoped region closes
   * it on failure.
   */
  const openSessionScope = Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    let transferred = false;
    yield* Effect.addFinalizer(() => (transferred ? Effect.void : Scope.close(scope, Exit.void)));
    return {
      scope,
      markTransferred: () => {
        transferred = true;
      },
    };
  });

  /**
   * The shared `session/request_permission` flow: full-access auto-approval,
   * deferred decision tracked in `pendingApprovals`, request.opened/resolved
   * runtime events, and wire outcome selected from the request's own options.
   */
  const makePermissionRequestHandler =
    (input: {
      readonly threadId: ThreadId;
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly pendingApprovals: Map<ApprovalRequestId, AcpPendingApproval>;
      readonly resolveTurnId: () => TurnId | undefined;
    }) =>
    (params: EffectAcpSchema.RequestPermissionRequest) =>
      mapAcpHandlerFailure("session/request_permission")(
        Effect.gen(function* () {
          yield* logNative(input.threadId, "session/request_permission", params);
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
          const permissionRequest = parsePermissionRequest(params);
          const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
          const runtimeRequestId = RuntimeRequestId.make(requestId);
          const decision = yield* Deferred.make<ProviderApprovalDecision>();
          input.pendingApprovals.set(requestId, {
            decision,
            kind: permissionRequest.kind,
          });
          yield* offerRuntimeEvent(
            makeAcpRequestOpenedEvent({
              stamp: yield* makeEventStamp(),
              provider,
              threadId: input.threadId,
              turnId: input.resolveTurnId(),
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
              provider,
              threadId: input.threadId,
              turnId: input.resolveTurnId(),
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
      );

  /**
   * Drains the runtime's parsed session events into canonical runtime events,
   * forked into the session scope so it outlives startSession.
   */
  const runSessionEventLoop = (
    ctx: Ctx,
    loopOptions?: {
      /**
       * Gate on the turn an emission is attributed to. Providers that must
       * suppress post-interrupt notifications return `emit: false`.
       */
      readonly resolveEmission?: (ctx: Ctx) => {
        readonly emit: boolean;
        readonly turnId: TurnId | undefined;
      };
    },
  ) =>
    Stream.runDrain(
      Stream.mapEffect(ctx.acp.getEvents(), (event) =>
        Effect.gen(function* () {
          if (event._tag === "EventStreamBarrier") {
            yield* Deferred.succeed(event.acknowledge, undefined);
            return;
          }
          if (
            event._tag === "PlanUpdated" ||
            event._tag === "ToolCallUpdated" ||
            event._tag === "ContentDelta"
          ) {
            yield* logNative(ctx.threadId, "session/update", event.rawPayload);
          }
          if (event._tag === "ModeChanged") {
            return;
          }
          const emission = loopOptions?.resolveEmission?.(ctx) ?? {
            emit: true,
            turnId: ctx.activeTurnId,
          };
          if (!emission.emit) {
            return;
          }
          switch (event._tag) {
            case "AssistantItemStarted":
              yield* offerRuntimeEvent(
                makeAcpAssistantItemEvent({
                  stamp: yield* makeEventStamp(),
                  provider,
                  threadId: ctx.threadId,
                  turnId: emission.turnId,
                  itemId: event.itemId,
                  lifecycle: "item.started",
                }),
              );
              return;
            case "AssistantItemCompleted":
              yield* offerRuntimeEvent(
                makeAcpAssistantItemEvent({
                  stamp: yield* makeEventStamp(),
                  provider,
                  threadId: ctx.threadId,
                  turnId: emission.turnId,
                  itemId: event.itemId,
                  lifecycle: "item.completed",
                }),
              );
              return;
            case "PlanUpdated":
              yield* emitPlanUpdate(ctx, {
                turnId: emission.turnId,
                payload: event.payload,
                rawPayload: event.rawPayload,
                source: "acp.jsonrpc",
                method: "session/update",
              });
              return;
            case "ToolCallUpdated":
              yield* offerRuntimeEvent(
                makeAcpToolCallEvent({
                  stamp: yield* makeEventStamp(),
                  provider,
                  threadId: ctx.threadId,
                  turnId: emission.turnId,
                  toolCall: event.toolCall,
                  rawPayload: event.rawPayload,
                }),
              );
              return;
            case "ContentDelta":
              yield* offerRuntimeEvent(
                makeAcpContentDeltaEvent({
                  stamp: yield* makeEventStamp(),
                  provider,
                  threadId: ctx.threadId,
                  turnId: emission.turnId,
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
        Effect.logError(`Failed to process ${options.providerLabel} runtime notification.`, {
          cause,
        }),
      ),
      // Fork into the session scope, not the calling fiber. `forkChild`
      // makes this a child of `startSession`, and Effect interrupts a
      // fiber's children when it completes, so the consumer died as soon
      // as `startSession` returned and every later notification was
      // dropped. The scope is created, stored on the context and closed
      // on teardown already; only the fork target was wrong.
      Effect.forkIn(ctx.scope),
    );

  /**
   * Registers the session, transfers scope ownership to it, and emits the
   * session.started / session.state.changed / thread.started trio.
   */
  const attachSession = Effect.fn("AcpAdapterCore.attachSession")(function* (input: {
    readonly ctx: Ctx;
    readonly notificationFiber: Fiber.Fiber<void, never>;
    readonly markScopeTransferred: () => void;
    /** Value published on session.started; providers may fix up capabilities. */
    readonly resumePayload: unknown;
    readonly providerThreadId: string;
  }) {
    input.ctx.notificationFiber = input.notificationFiber;
    sessions.set(input.ctx.threadId, input.ctx);
    input.markScopeTransferred();

    yield* offerRuntimeEvent({
      type: "session.started",
      ...(yield* makeEventStamp()),
      provider,
      threadId: input.ctx.threadId,
      payload: { resume: input.resumePayload },
    });
    yield* offerRuntimeEvent({
      type: "session.state.changed",
      ...(yield* makeEventStamp()),
      provider,
      threadId: input.ctx.threadId,
      payload: { state: "ready", reason: `${options.providerLabel} ACP session ready` },
    });
    yield* offerRuntimeEvent({
      type: "thread.started",
      ...(yield* makeEventStamp()),
      provider,
      threadId: input.ctx.threadId,
      payload: { providerThreadId: input.providerThreadId },
    });
  });

  const respondToApproval = Effect.fn("AcpAdapterCore.respondToApproval")(function* (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) {
    const ctx = yield* requireSession(threadId);
    const pending = ctx.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider,
        method: "session/request_permission",
        detail: `Unknown pending approval request: ${requestId}`,
      });
    }
    ctx.pendingApprovals.delete(requestId);
    const settled = yield* Deferred.succeed(pending.decision, decision);
    if (!settled) {
      return yield* new ProviderAdapterRequestError({
        provider,
        method: "session/request_permission",
        detail: `Approval request was already resolved: ${requestId}`,
      });
    }
  });

  /** Settles pending interactions and forwards `session/cancel` to the agent. */
  const interruptActiveTurn = Effect.fn("AcpAdapterCore.interruptActiveTurn")(function* (
    threadId: ThreadId,
  ) {
    const ctx = yield* requireSession(threadId);
    yield* options.settlePendingInteractions(ctx);
    yield* Effect.ignore(ctx.acp.cancel);
  });

  /**
   * Runs one prompt under the shared turn reservation/settlement policy:
   *
   * - The active turn is reserved under the thread lock before any
   *   provider/configuration yield; concurrent sends are steers and must
   *   observe the first send's id.
   * - Completion is decided and the reservation released under the same
   *   thread lock used by new sends, uninterruptibly. A send either joins
   *   this turn before the decision or starts a new turn after its
   *   completion is published.
   * - The reservation flag guarantees exactly one decrement per prompt.
   */
  const runReservedPrompt = Effect.fn("AcpAdapterCore.runReservedPrompt")(function* <
    E,
    E2,
    R,
  >(input: {
    readonly threadId: ThreadId;
    readonly prompt: (
      reservation: AcpTurnReservation<Ctx>,
    ) => Effect.Effect<EffectAcpSchema.PromptResponse, E, R>;
    /** Records the finished prompt on the thread/session snapshot. */
    readonly recordResult: (
      reservation: AcpTurnReservation<Ctx>,
      result: EffectAcpSchema.PromptResponse,
    ) => Effect.Effect<void, E2>;
  }) {
    yield* options.testHooks?.beforeTurnReservation ?? Effect.void;
    const reservation = yield* withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
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
        return { ctx, steeringTurnId, turnId } satisfies AcpTurnReservation<Ctx>;
      }),
    );
    const { ctx, turnId } = reservation;
    let promptReservationReleased = false;

    return yield* Effect.gen(function* () {
      const result = yield* input.prompt(reservation);
      yield* input.recordResult(reservation, result);

      yield* withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          ctx.promptsInFlight -= 1;
          promptReservationReleased = true;
          const shouldCompleteTurn = ctx.promptsInFlight === 0;
          yield* options.testHooks?.afterPromptSettlementDecision ?? Effect.void;
          if (shouldCompleteTurn) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider,
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
                  ctx.promptsInFlight -= 1;
                  promptReservationReleased = true;
                }),
              ),
        ),
      ),
    );
  });

  return {
    provider,
    sessions,
    nativeEventLogger,
    makeSessionNativeLoggers,
    nowIso,
    randomUUIDv4,
    makeEventStamp,
    offerRuntimeEvent,
    withThreadLock,
    logNative,
    emitPlanUpdate,
    requireSession,
    stopSessionInternal,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents,
    openSessionScope,
    makePermissionRequestHandler,
    runSessionEventLoop,
    attachSession,
    respondToApproval,
    interruptActiveTurn,
    runReservedPrompt,
  };
});
