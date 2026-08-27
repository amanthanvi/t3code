import { type ClineSettings } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
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

export const makeClineAcpRuntime = (
  input: ClineAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  AcpSessionRuntime.makeAcpRuntime({
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
  });

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
}): Effect.fn.Return<void, E> {
  const requested = input.requestedModelId?.trim();
  if (!requested) {
    return;
  }
  const configOptions = yield* input.runtime.getConfigOptions;
  const option = findClineModelConfigOptionIn(configOptions);
  if (!option) {
    return;
  }
  if (option.options.every((entry) => !("value" in entry) && entry.options.length === 0)) {
    return;
  }
  if (option.currentValue.trim() === requested) {
    return;
  }
  yield* input.runtime.setConfigOption(option.id, requested).pipe(Effect.mapError(input.mapError));
});
