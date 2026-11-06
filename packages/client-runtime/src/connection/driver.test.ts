import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionTransientError,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionAttemptError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const environmentId = EnvironmentId.make("route-recovery-test");
const fallback = new PrimaryConnectionTarget({
  environmentId,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const relay = new RelayConnectionTarget({ environmentId, label: fallback.label });
const entry: ConnectionCatalogEntry = {
  target: relay,
  profile: Option.none(),
  alternateRoutes: [{ target: fallback, profile: Option.none() }],
  enabled: true,
};

const makeHarness = Effect.gen(function* () {
  const preparationFailure = yield* Ref.make<Option.Option<ConnectionAttemptError>>(
    Option.some(new ConnectionTransientError({ reason: "session-pending", detail: "Loading." })),
  );
  const active = yield* Ref.make<ReadonlyArray<PreparedConnection>>([]);
  const released = yield* Queue.unbounded<PreparedConnection>();
  const relayReady = yield* Ref.make<Effect.Effect<void, ConnectionAttemptError>>(Effect.void);
  const http = RpcHttp.layerRemoteHttpClient(() =>
    Promise.resolve(
      Response.json({
        environmentId,
        label: fallback.label,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      }),
    ),
  );
  const driver = yield* ConnectionDriver.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        http,
        Layer.succeed(ConnectionResolver.ConnectionResolver, {
          prepare: (route) =>
            Effect.gen(function* () {
              const failure = yield* Ref.get(preparationFailure);
              if (route.target._tag === "RelayConnectionTarget" && Option.isSome(failure)) {
                return yield* failure.value;
              }
              return {
                environmentId,
                label: fallback.label,
                target: route.target,
                httpBaseUrl: fallback.httpBaseUrl,
                socketUrl: "wss://environment.example.test/ws",
                httpAuthorization: null,
              } satisfies PreparedConnection;
            }),
          prepareForUpdate: () => Effect.die("Unexpected update preparation."),
        }),
        Layer.succeed(RpcSession.RpcSessionFactory, {
          connect: (prepared) =>
            Effect.acquireRelease(
              Ref.update(active, (current) => [...current, prepared]).pipe(
                Effect.as({
                  client: {} as WsRpcProtocolClient,
                  initialConfig: Effect.die("Unused initial config."),
                  subscribeServerConfig: () => Stream.never,
                  ready:
                    prepared.target._tag === "RelayConnectionTarget"
                      ? Ref.get(relayReady).pipe(Effect.flatten)
                      : Effect.void,
                  probe: Effect.void,
                  inboundFrames: Effect.succeed(0),
                  closed: Effect.never,
                } satisfies RpcSession.RpcSession),
              ),
              () =>
                Ref.update(active, (current) => current.filter((item) => item !== prepared)).pipe(
                  Effect.andThen(Queue.offer(released, prepared)),
                ),
            ),
        }),
        Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
          authorizeBearer: () => Effect.die("Unexpected authorization."),
          authorizeDpop: () => Effect.die("Unexpected authorization."),
          authorizeDpopHttp: () => Effect.die("Unexpected authorization."),
          renewDpopBeforeExpiry: () => Effect.never,
        }),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(ConnectionDriver.ConnectionDriver, driver),
    Layer.succeed(Connectivity.Connectivity, {
      status: Effect.succeed<NetworkStatus>("online"),
      changes: Stream.never,
    }),
    Layer.succeed(ConnectionWakeups.ConnectionWakeups, { changes: Stream.never }),
  );
  return { driver, dependencies, preparationFailure, active, released, relayReady };
});

const connectedGeneration = (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  generation: number,
) =>
  SubscriptionRef.changes(state).pipe(
    Stream.filter((value) => value.phase === "connected" && value.generation === generation),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("ConnectionDriver preferred relay recovery", () => {
  it.effect("promotes a recovered preferred relay without manual client recovery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const supervisor = yield* EnvironmentSupervisor.make(entry, { initiallyDesired: true }).pipe(
        Effect.provide(harness.dependencies),
      );
      yield* connectedGeneration(supervisor.state, 1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target).toEqual(
        fallback,
      );

      yield* Ref.set(harness.preparationFailure, Option.none());
      yield* TestClock.adjust("60 seconds");
      // A recovered route must be authorized and ready before replacing the healthy fallback.
      expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(2);
      yield* connectedGeneration(supervisor.state, 2);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target).toEqual(
        relay,
      );
      expect((yield* Ref.get(harness.active)).map((connection) => connection.target)).toEqual([
        relay,
      ]);
    }),
  );

  it.effect("keeps the fallback while relay readiness fails and closes the trial session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const supervisor = yield* EnvironmentSupervisor.make(entry, { initiallyDesired: true }).pipe(
        Effect.provide(harness.dependencies),
      );
      yield* connectedGeneration(supervisor.state, 1);
      const checking = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void, ConnectionAttemptError>();
      yield* Ref.set(harness.preparationFailure, Option.none());
      yield* Ref.set(
        harness.relayReady,
        Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(ready))),
      );
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.await(checking);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target).toEqual(
        fallback,
      );

      yield* Deferred.fail(
        ready,
        new ConnectionTransientError({
          reason: "transport",
          detail: "Relay socket failed before readiness.",
        }),
      );
      expect((yield* Queue.take(harness.released)).target).toEqual(relay);
      expect((yield* Ref.get(harness.active)).map((connection) => connection.target)).toEqual([
        fallback,
      ]);
      expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
    }),
  );

  it.effect("does not advertise a relay without usable credentials", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      for (const failure of [
        new ConnectionTransientError({ reason: "session-pending", detail: "Loading sign-in." }),
        new ConnectionBlockedError({ reason: "authentication", detail: "Missing credential." }),
        new ConnectionBlockedError({ reason: "permission", detail: "Access denied." }),
        new ConnectionBlockedError({ reason: "configuration", detail: "No signing key." }),
      ]) {
        yield* Ref.set(harness.preparationFailure, Option.some(failure));
        expect(
          yield* harness.driver.preflight(entry, { target: relay, profile: Option.none() }),
        ).toBe("unprepared");
      }
      expect(yield* Ref.get(harness.active)).toEqual([]);
    }),
  );

  it.effect("closes an interrupted relay trial without releasing the active fallback", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.driver.connect(
        { ...entry, target: fallback, alternateRoutes: [] },
        () => Effect.void,
      );
      yield* Ref.set(harness.preparationFailure, Option.none());
      const checking = yield* Deferred.make<void>();
      yield* Ref.set(
        harness.relayReady,
        Deferred.succeed(checking, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const trial = yield* Effect.forkChild(
        harness.driver.preflight(entry, { target: relay, profile: Option.none() }),
      );
      yield* Deferred.await(checking);
      yield* Fiber.interrupt(trial);
      expect((yield* Ref.get(harness.active)).map((connection) => connection.target)).toEqual([
        fallback,
      ]);
    }),
  );

  it.effect("retries after a relay never supplies its initial snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const supervisor = yield* EnvironmentSupervisor.make(entry, { initiallyDesired: true }).pipe(
        Effect.provide(harness.dependencies),
      );
      yield* connectedGeneration(supervisor.state, 1);
      yield* Ref.set(harness.preparationFailure, Option.none());
      yield* Ref.set(harness.relayReady, Effect.never);
      yield* TestClock.adjust("60 seconds");
      expect((yield* Ref.get(harness.active)).map((connection) => connection.target)).toEqual([
        fallback,
        relay,
      ]);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target).toEqual(
        fallback,
      );

      yield* Ref.set(harness.relayReady, Effect.void);
      yield* TestClock.adjust("90 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(2);
      yield* connectedGeneration(supervisor.state, 2);
      expect((yield* Ref.get(harness.active)).map((connection) => connection.target)).toEqual([
        relay,
      ]);
    }),
  );

  it.effect("retains HTTP descriptor checks and leaves SSH preflight unchecked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      expect(
        yield* harness.driver.preflight(entry, { target: fallback, profile: Option.none() }),
      ).toBe("ready");
      const ssh = new SshConnectionTarget({
        environmentId,
        label: fallback.label,
        connectionId: "ssh:test",
      });
      expect(yield* harness.driver.preflight(entry, { target: ssh, profile: Option.none() })).toBe(
        "unchecked",
      );
      expect(yield* Ref.get(harness.active)).toEqual([]);
    }),
  );
});
