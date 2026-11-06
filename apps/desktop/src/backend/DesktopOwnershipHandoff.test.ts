// @effect-diagnostics nodeBuiltinImport:off - The helper fixture is a real isolated bundled-runtime boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { acquireDesktopSupervisor } from "@t3tools/shared/desktopOwnership";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopOwnershipHandoff from "./DesktopOwnershipHandoff.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const layerEnvironment = (baseDir: string) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

const backend = (
  currentConfig: DesktopBackendPool.DesktopBackendInstance["currentConfig"],
  stop: DesktopBackendPool.DesktopBackendInstance["stop"],
): DesktopBackendPool.DesktopBackendInstance => ({
  id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
  label: Effect.succeed("Mac"),
  start: Effect.void,
  stop,
  currentConfig,
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
});

it.effect(
  "relaunching after disabling the local environment leaves no helper or retained parent",
  () => {
    let stopped = false;
    const layer = DesktopOwnershipHandoff.layer.pipe(
      Layer.provide(
        DesktopBackendPool.layerTest([
          backend(Effect.die("disabled home must not resolve runtime"), () =>
            Effect.sync(() => {
              stopped = true;
            }),
          ),
        ]),
      ),
      Layer.provide(
        Layer.mock(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.succeed({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          }),
        }),
      ),
      Layer.provide(layerEnvironment("/unused-disabled-home")),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const handoff = yield* DesktopOwnershipHandoff.DesktopOwnershipHandoff;
        yield* handoff.prepare;
        yield* handoff.commit;
        assert.isFalse(stopped);
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.live.each([
  "failed recovery",
  "interrupted acquisition",
  "scope close during acquisition",
  "explicit cancel during acquisition",
])("normal quit cancels the helper after %s", (scenario) =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-recovery-"));
    const parent = acquireDesktopSupervisor(baseDir);
    const entryPath = NodePath.join(baseDir, "helper.mjs");
    NodeFS.writeFileSync(
      entryPath,
      `import { runDesktopHandoff } from ${JSON.stringify(new URL("../../../../packages/shared/src/desktopHandoff.ts", import.meta.url).href)};
        ${
          scenario !== "failed recovery"
            ? `
          const { createServer } = await import('node:net');
          const fs = await import('node:fs');
          await new Promise((resolve) => {
            const server = createServer((socket) => { socket.end(); server.close(resolve); });
            server.listen(0, '127.0.0.1', () => {
              fs.writeFileSync(${JSON.stringify(NodePath.join(baseDir, "started.tmp"))}, String(server.address().port));
              fs.renameSync(${JSON.stringify(NodePath.join(baseDir, "started.tmp"))}, ${JSON.stringify(NodePath.join(baseDir, "started"))});
            });
          });
        `
            : ""
        }
        await runDesktopHandoff();`,
    );
    let retained = false;
    const instance = backend(
      Effect.succeedSome({
        executablePath: process.execPath,
        entryPath,
        args: [entryPath],
        cwd: baseDir,
        env: {},
        extendEnv: true,
        bootstrapDelivery: "fd3",
        captureOutput: true,
        preflightFailure: Option.none(),
        httpBaseUrl: new URL("http://127.0.0.1:1"),
        bootstrap: {
          mode: "desktop",
          noBrowser: true,
          port: 1,
          t3Home: baseDir,
          host: "127.0.0.1",
          desktopBootstrapToken: "test",
          tailscaleServeEnabled: false,
          tailscaleServePort: 1,
        },
      }),
      (options) =>
        Effect.sync(() => {
          retained = options?.preserveOwnership === true;
        }),
    );
    const layer = DesktopOwnershipHandoff.layer.pipe(
      Layer.provide(DesktopBackendPool.layerTest([instance])),
      Layer.provide(
        Layer.mock(DesktopAppSettings.DesktopAppSettings, {
          get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        }),
      ),
      Layer.provide(layerEnvironment(baseDir)),
    );
    const preparing =
      Promise.withResolvers<
        Fiber.Fiber<void, DesktopOwnershipHandoff.DesktopOwnershipHandoffError>
      >();
    const started = Promise.withResolvers<void>();
    const scopeClosing = Promise.withResolvers<void>();
    const watcher = NodeFS.watch(baseDir, (_event, filename) => {
      if (filename === "started") started.resolve();
    });
    try {
      const running = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const handoff = yield* DesktopOwnershipHandoff.DesktopOwnershipHandoff;
            if (scenario !== "failed recovery") {
              const acquiring = yield* handoff.prepare.pipe(
                scenario === "scope close during acquisition"
                  ? Effect.forkDetach
                  : Effect.forkChild,
              );
              preparing.resolve(acquiring);
              if (scenario === "interrupted acquisition") yield* Fiber.await(acquiring);
              else if (scenario === "explicit cancel during acquisition") {
                yield* Effect.promise(() => started.promise);
                const cancelling = yield* handoff.cancel.pipe(Effect.forkChild);
                scopeClosing.resolve();
                yield* Fiber.join(cancelling);
                yield* Fiber.await(acquiring);
                assert.isTrue(Exit.isFailure(yield* handoff.commit.pipe(Effect.exit)));
                assert.isFalse(retained);
              } else {
                yield* Effect.promise(() => started.promise);
                scopeClosing.resolve();
              }
            } else {
              yield* handoff.prepare;
              yield* handoff.commit;
              assert.isTrue(retained);
              yield* handoff.recover;
            }
          }),
        ).pipe(Effect.provide(layer)),
      );
      if (scenario !== "failed recovery") {
        yield* Effect.promise(() => started.promise);
        const acquiring = yield* Effect.promise(() => preparing.promise);
        if (scenario === "interrupted acquisition") acquiring.interruptUnsafe();
        else yield* Effect.promise(() => scopeClosing.promise);
        const port = Number(NodeFS.readFileSync(NodePath.join(baseDir, "started"), "utf8"));
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
              socket.once("error", reject);
              socket.once("end", () => resolve());
            }),
        );
      }
      yield* Fiber.join(running);
      assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "runtime", ".desktop-handoff.json")));
    } finally {
      watcher.close();
      parent.close();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);
