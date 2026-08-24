import { type ClineSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { findSessionConfigOption } from "./AcpRuntimeModel.ts";

type ClineAcpSetupResponse =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

type ClineAcpRuntimeClineSettings = Pick<ClineSettings, "binaryPath">;

export const CLINE_PROCESS_FORCE_KILL_AFTER = "2 seconds";

export interface ClineAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly clineSettings: ClineAcpRuntimeClineSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly forceKillAfter?: Duration.Input;
}

export function buildClineAcpSpawnInput(
  clineSettings: ClineAcpRuntimeClineSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  forceKillAfter?: Duration.Input,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: clineSettings?.binaryPath || "cline",
    args: ["--acp"],
    cwd,
    ...(forceKillAfter !== undefined ? { forceKillAfter } : {}),
    ...(environment ? { env: environment } : {}),
  };
}

export const makeClineAcpRuntime = Effect.fn("makeClineAcpRuntime")(function* (
  input: ClineAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> {
  const acpContext = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      // Cline returns its model config only in the authoritative load response;
      // replay notifications cannot safely populate the synthetic idle fallback.
      sessionLoadReplayIdleFallback: false,
      spawn: buildClineAcpSpawnInput(
        input.clineSettings,
        input.cwd,
        input.environment,
        input.forceKillAfter,
      ),
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(acpContext),
  );
});

export const startClineAcpRuntimeWithTimeout = Effect.fn("startClineAcpRuntimeWithTimeout")(
  function* (input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly timeout: Duration.Input;
    readonly forceKillAfter: Duration.Input;
  }) {
    // An unresponsive JSON-RPC request can make interruption wait forever.
    // Observe detached startup as data so the timeout path can terminate the
    // exact owned child before the surrounding runtime scope is closed.
    const startFiber = yield* input.runtime.start().pipe(Effect.forkDetach);
    const startedExit = yield* Fiber.await(startFiber).pipe(Effect.timeoutOption(input.timeout));
    if (Option.isNone(startedExit)) {
      yield* input.runtime.terminate(input.forceKillAfter).pipe(Effect.ignore);
      return Option.none();
    }
    if (Exit.isFailure(startedExit.value)) {
      return yield* Effect.failCause(startedExit.value.cause);
    }
    return Option.some(startedExit.value.value);
  },
);

type ClineModelSelectOption = Extract<EffectAcpSchema.SessionConfigOption, { type: "select" }>;

function findClineModelConfigOptionIn(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ClineModelSelectOption | undefined {
  if (!configOptions) return undefined;
  const byId = findSessionConfigOption(configOptions, "model");
  if (byId && byId.type === "select") return byId;
  const byCategory = configOptions.find(
    (option) => option.type === "select" && option.category === "model" && option.id !== "provider",
  );
  return byCategory && byCategory.type === "select" ? byCategory : undefined;
}

function findClineModelConfigOption(
  sessionSetupResult: ClineAcpSetupResponse,
): ClineModelSelectOption | undefined {
  return findClineModelConfigOptionIn(sessionSetupResult.configOptions);
}

export function currentClineModelIdFromSessionSetup(
  sessionSetupResult: ClineAcpSetupResponse,
): string | undefined {
  const option = findClineModelConfigOption(sessionSetupResult);
  if (!option) return undefined;
  const current = option.currentValue.trim();
  return current.length > 0 ? current : undefined;
}

export interface ClineDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly isDefault?: boolean;
}

export function clineModelsFromSessionConfigOptions(
  sessionSetupResult: ClineAcpSetupResponse,
): ReadonlyArray<ClineDiscoveredModel> {
  const option = findClineModelConfigOption(sessionSetupResult);
  if (!option) return [];
  const current = currentClineModelIdFromSessionSetup(sessionSetupResult);
  const models = new Map<string, ClineDiscoveredModel>();
  for (const entry of option.options) {
    const values = "value" in entry ? [entry] : entry.options;
    for (const { value, name } of values) {
      const slug = value.trim();
      if (slug.length === 0 || models.has(slug)) continue;
      const normalizedName = name.trim();
      models.set(slug, {
        slug,
        name: normalizedName.length > 0 ? normalizedName : slug,
        ...(slug === current ? { isDefault: true } : {}),
      });
    }
  }
  return [...models.values()];
}

export const applyClineAcpModelSelection = Effect.fn("applyClineAcpModelSelection")(function* <
  E,
>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly requestedModelId: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.fn.Return<string | void, E> {
  const requested = input.requestedModelId?.trim();
  if (!requested) {
    return;
  }
  const configOptions = yield* input.runtime.getConfigOptions;
  const option = findClineModelConfigOptionIn(configOptions);
  if (!option) {
    return undefined;
  }
  if (option.options.every((entry) => !("value" in entry) && entry.options.length === 0)) {
    return undefined;
  }
  if (option.currentValue.trim() === requested) {
    return requested;
  }
  yield* input.runtime.setConfigOption(option.id, requested).pipe(Effect.mapError(input.mapError));
  return requested;
});
