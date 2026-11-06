// @effect-diagnostics nodeBuiltinImport:off - Native handoff regression uses a private real worker.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { acquireDesktopSupervisor } from "@t3tools/shared/desktopOwnership";
import { startDesktopHandoff } from "@t3tools/shared/desktopHandoff";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as HostProcess from "@t3tools/shared/HostProcess";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopOwnershipHandoff from "../backend/DesktopOwnershipHandoff.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
  exit: (code: number) => Effect.Effect<void> = () => Effect.void,
  relaunch: (options: Electron.RelaunchOptions) => Effect.Effect<void> = () => Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit,
    exit,
    relaunch,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    getAppMetrics: Effect.succeed([]),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    runMainContentsCommand: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

describe("DesktopLifecycle", () => {
  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let windowsDestroyed = false;
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(DesktopOwnershipHandoff.DesktopOwnershipHandoff, {
            prepare: Effect.void,
            commit: Effect.void,
            check: Effect.void,
            cancel: Effect.void,
            recover: Effect.void,
          }),
        ),
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              windowsDestroyed = true;
            }),
          ),
        ),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect.each(["before-quit", "SIGTERM during update preparation"])(
    "cleans up before waiting for backend shutdown from %s",
    (source) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const shutdownRequested = yield* Deferred.make<void>();
        const allowShutdown = yield* Deferred.make<void>();
        const quitRequested = yield* Deferred.make<void>();
        const events: string[] = [];

        const quit = Effect.sync(() => {
          events.push("quit");
        }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
        const destroyAll = Effect.sync(() => {
          events.push("destroy");
        });
        const flushMainWindowBounds = Effect.sync(() => {
          events.push("flush");
        });

        const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
          request: Effect.sync(() => {
            events.push("request");
          }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
          awaitRequest: Deferred.await(shutdownRequested),
          markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
          awaitComplete: Deferred.await(allowShutdown),
          isComplete: Deferred.isDone(allowShutdown),
        });

        const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]);

        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopOwnershipHandoff.DesktopOwnershipHandoff, {
              prepare: Effect.void,
              commit: Effect.void,
              check: Effect.void,
              cancel: Effect.sync(() => {
                events.push("cancel");
              }),
              recover: Effect.void,
            }),
          ),
          Layer.provideMerge(layerElectronApp(appListeners, quit)),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(layerElectronWindow(destroyAll)),
          Layer.provideMerge(layerDesktopWindow({ flushMainWindowBounds })),
          Layer.provideMerge(layerEnvironment),
          Layer.provideMerge(layerDesktopShutdown),
          Layer.provideMerge(DesktopState.layer),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
            const signalListeners = new Set(process.listeners("SIGTERM"));
            yield* lifecycle.register;

            if (source === "SIGTERM during update preparation") {
              yield* Ref.set((yield* DesktopState.DesktopState).quitting, true);
              const sigterm = process
                .listeners("SIGTERM")
                .find((listener) => !signalListeners.has(listener));
              if (sigterm === undefined)
                throw new Error("The lifecycle SIGTERM listener was not registered.");
              sigterm("SIGTERM");
            } else {
              const event = { preventDefault: () => undefined } as Electron.Event;
              appListeners.get("before-quit")?.(event);
            }

            yield* Deferred.await(shutdownRequested);
            const eventsBeforeCleanup = [...events];
            yield* Deferred.succeed(allowShutdown, undefined);
            yield* Deferred.await(quitRequested);

            const expectedCleanup =
              source === "before-quit"
                ? ["cancel", "flush", "destroy", "request"]
                : ["cancel", "flush", "request"];
            assert.deepEqual(eventsBeforeCleanup, expectedCleanup);
            assert.deepEqual(events, [...expectedCleanup, "quit"]);
          }),
        ).pipe(Effect.provide(layer));
      }),
  );

  it.effect("relaunches without the app link that launched it", () =>
    Effect.gen(function* () {
      const relaunched = yield* Deferred.make<Electron.RelaunchOptions>();
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "linux",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(DesktopOwnershipHandoff.DesktopOwnershipHandoff, {
            prepare: Effect.void,
            commit: Effect.void,
            check: Effect.void,
            cancel: Effect.void,
            recover: Effect.void,
          }),
        ),
        Layer.provideMerge(
          layerElectronApp(
            new Map(),
            Effect.void,
            () => Effect.void,
            (options) => Deferred.succeed(relaunched, options).pipe(Effect.asVoid),
          ),
        ),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      const options = yield* Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* (yield* DesktopShutdown.DesktopShutdown).markComplete;
        yield* lifecycle.relaunch("network access changed");
        return yield* Deferred.await(relaunched);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(HostProcess.ExecutablePath, "/opt/T3 Code/t3code"),
        Effect.provideService(HostProcess.Arguments, [
          "/opt/T3 Code/t3code",
          "--no-sandbox",
          "T3CODE://pair?token=spent",
          "t3code://new?prompt=hello",
        ]),
      );

      assert.deepEqual(options, { execPath: "/opt/T3 Code/t3code", args: ["--no-sandbox"] });
    }),
  );

  it.effect("exits on a repeated quit only once shutdown has stalled", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const exitCodes: number[] = [];
      const exit = (code: number) =>
        Effect.sync(() => {
          exitCodes.push(code);
        });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(DesktopOwnershipHandoff.DesktopOwnershipHandoff, {
            prepare: Effect.void,
            commit: Effect.void,
            check: Effect.void,
            cancel: Effect.void,
            recover: Effect.void,
          }),
        ),
        Layer.provideMerge(layerElectronApp(appListeners, Effect.void, exit)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        // Nothing marks this shutdown complete, so it stays pending.
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          let prevented = 0;
          const event = {
            preventDefault: () => {
              prevented += 1;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);
          appListeners.get("before-quit")?.(event);
          yield* TestClock.adjust("9999 millis");
          appListeners.get("before-quit")?.(event);
          assert.deepEqual(
            exitCodes,
            [],
            "a repeat before the threshold must not cut shutdown short",
          );

          yield* TestClock.adjust("1 millis");
          appListeners.get("before-quit")?.(event);

          assert.deepEqual(exitCodes, [0]);
          assert.equal(prevented, 4);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(DesktopOwnershipHandoff.DesktopOwnershipHandoff, {
            prepare: Effect.void,
            commit: Effect.void,
            check: Effect.void,
            cancel: Effect.void,
            recover: Effect.void,
          }),
        ),
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow({ activate })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});

it.effect.each([false, true])(
  "retains ownership and cleans up when relaunch failure is %s",
  (fails) =>
    Effect.gen(function* () {
      const events: string[] = [];
      const exited = yield* Deferred.make<void>();
      const mark = (event: string) =>
        Effect.sync(() => {
          events.push(event);
        });
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(DesktopOwnershipHandoff.DesktopOwnershipHandoff, {
            prepare: mark("reserved"),
            commit: mark("committed"),
            check: Effect.void,
            cancel: mark("cancelled").pipe(
              Effect.andThen(Deferred.succeed(exited, undefined)),
              Effect.asVoid,
            ),
            recover: mark("recovering"),
          }),
        ),
        Layer.provideMerge(
          layerElectronApp(
            new Map(),
            Effect.void,
            () =>
              mark("exit").pipe(Effect.andThen(Deferred.succeed(exited, undefined)), Effect.asVoid),
            () =>
              mark("relaunch").pipe(
                Effect.andThen(fails ? Effect.die(new Error("relaunch failed")) : Effect.void),
              ),
          ),
        ),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(
          Layer.succeed(DesktopShutdown.DesktopShutdown, {
            request: mark("shutdown"),
            awaitComplete: Effect.void,
            awaitRequest: Effect.never,
            markComplete: Effect.void,
            isComplete: Effect.succeed(true),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: "darwin",
            isDevelopment: false,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
        Layer.provideMerge(DesktopState.layer),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.relaunch("ownership-test");
          yield* Deferred.await(exited);
          assert.deepEqual(events, [
            "reserved",
            "committed",
            "shutdown",
            "relaunch",
            ...(fails ? ["recovering", "cancelled"] : ["exit"]),
          ]);
        }),
      ).pipe(Effect.provide(layer));
    }),
);

it.live("refuses relaunch when the real helper exits while native shutdown is pending", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relaunch-loss-"));
    const parent = acquireDesktopSupervisor(NodePath.join(baseDir, "userdata"));
    let worker: Awaited<ReturnType<typeof startDesktopHandoff>> | undefined;
    let relaunched = false;
    let exited = false;
    const cancelled = Promise.withResolvers<void>();
    const layer = DesktopLifecycle.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(DesktopOwnershipHandoff.DesktopOwnershipHandoff, {
          prepare: Effect.promise(async () => {
            worker = await startDesktopHandoff({
              executablePath: process.execPath,
              args: [
                new URL("../../../server/src/bin.ts", import.meta.url).pathname,
                "__desktop-handoff",
              ],
              cwd: baseDir,
              env: process.env,
              stateDir: NodePath.join(baseDir, "userdata"),
            });
          }),
          commit: Effect.promise(async () => {
            await worker!.assertAlive();
          }),
          check: Effect.tryPromise({
            try: async () => {
              await worker!.assertAlive();
            },
            catch: (cause) => new DesktopOwnershipHandoff.DesktopOwnershipHandoffError({ cause }),
          }),
          recover: Effect.void,
          cancel: Effect.promise(async () => {
            await worker?.cancel();
            cancelled.resolve();
          }),
        }),
      ),
      Layer.provideMerge(
        layerElectronApp(
          new Map(),
          Effect.void,
          () =>
            Effect.sync(() => {
              exited = true;
            }),
          () =>
            Effect.sync(() => {
              relaunched = true;
            }),
        ),
      ),
      Layer.provideMerge(layerElectronTheme),
      Layer.provideMerge(layerElectronWindow()),
      Layer.provideMerge(layerDesktopWindow()),
      Layer.provideMerge(
        Layer.succeed(DesktopShutdown.DesktopShutdown, {
          request: Effect.void,
          awaitComplete: Effect.promise(async () => {
            await worker!.cancel();
          }),
          awaitRequest: Effect.never,
          markComplete: Effect.void,
          isComplete: Effect.succeed(true),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
      Layer.provideMerge(DesktopState.layer),
    );
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.relaunch("helper-loss");
          yield* Effect.promise(() => cancelled.promise);
          assert.isFalse(relaunched);
          assert.isFalse(exited);
        }),
      ).pipe(Effect.provide(layer));
    } finally {
      yield* Effect.promise(async () => {
        await worker?.cancel();
      });
      parent.close();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);
