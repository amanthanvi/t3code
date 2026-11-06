import { startDesktopHandoff } from "@t3tools/shared/desktopHandoff";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export class DesktopOwnershipHandoffError extends Schema.TaggedError<DesktopOwnershipHandoffError>()(
  "DesktopOwnershipHandoffError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not reserve this T3 home for the desktop restart. No update was installed.";
  }
}

export class DesktopOwnershipHandoff extends Context.Service<
  DesktopOwnershipHandoff,
  {
    readonly prepare: Effect.Effect<void, DesktopOwnershipHandoffError>;
    readonly commit: Effect.Effect<void, DesktopOwnershipHandoffError>;
    readonly check: Effect.Effect<void, DesktopOwnershipHandoffError>;
    readonly cancel: Effect.Effect<void, DesktopOwnershipHandoffError>;
    readonly recover: Effect.Effect<void>;
  }
>()("@t3tools/desktop/backend/DesktopOwnershipHandoff") {}

export const layer = Layer.effect(
  DesktopOwnershipHandoff,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const processEnv = yield* HostProcess.Environment;
    let active: Awaited<ReturnType<typeof startDesktopHandoff>> | undefined;
    let committed = false;
    let closing = false;
    let cancelled = false;
    const mutex = yield* Semaphore.make(1);
    const cancelUnlocked = Effect.tryPromise({
      try: async () => {
        cancelled = true;
        await active?.cancel();
        active = undefined;
        committed = false;
      },
      catch: (cause) => new DesktopOwnershipHandoffError({ cause }),
    });
    const cancel = cancelUnlocked.pipe(mutex.withPermits(1), Effect.uninterruptible);
    const checkUnlocked = Effect.tryPromise({
      try: async () => {
        if (cancelled) throw new Error("The desktop handoff was cancelled.");
        await active?.assertAlive();
      },
      catch: (cause) => new DesktopOwnershipHandoffError({ cause }),
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true;
      }).pipe(
        Effect.andThen(
          mutex.withPermits(1)(
            Effect.suspend(() => (committed ? Effect.void : cancelUnlocked.pipe(Effect.ignore))),
          ),
        ),
      ),
    );
    return DesktopOwnershipHandoff.of({
      prepare: Effect.gen(function* () {
        if (closing)
          return yield* new DesktopOwnershipHandoffError({
            cause: new Error("The desktop is shutting down."),
          });
        cancelled = false;
        if (environment.platform !== "darwin" || active !== undefined) return;
        if (!(yield* appSettings.get).localEnvironmentEnabled) return;
        const primary = yield* pool.primary;
        if (!(yield* primary.snapshot).desiredRunning) return;
        const config = yield* primary.currentConfig;
        if (Option.isNone(config)) return;
        const entryIndex = config.value.args.indexOf(config.value.entryPath);
        if (config.value.bootstrapDelivery !== "fd3" || entryIndex === -1) {
          return yield* new DesktopOwnershipHandoffError({
            cause: new Error("Native runtime is unavailable."),
          });
        }
        active = yield* Effect.tryPromise({
          try: () =>
            startDesktopHandoff({
              executablePath: config.value.executablePath,
              args: [...config.value.args.slice(0, entryIndex + 1), "__desktop-handoff"],
              cwd: config.value.cwd,
              env: { ...processEnv, ...config.value.env },
              baseDir: environment.baseDir,
            }),
          catch: (cause) => new DesktopOwnershipHandoffError({ cause }),
        });
      }).pipe(mutex.withPermits(1), Effect.uninterruptible),
      commit: Effect.gen(function* () {
        if (closing || cancelled)
          return yield* new DesktopOwnershipHandoffError({
            cause: new Error("The desktop is shutting down."),
          });
        yield* checkUnlocked;
        if (active !== undefined) {
          const primary = yield* pool.primary;
          yield* primary.stop({ preserveOwnership: true });
        }
        committed = true;
      }).pipe(mutex.withPermits(1), Effect.uninterruptible),
      check: checkUnlocked.pipe(mutex.withPermits(1), Effect.uninterruptible),
      recover: Effect.sync(() => {
        committed = false;
      }).pipe(mutex.withPermits(1)),
      cancel,
    });
  }),
);
