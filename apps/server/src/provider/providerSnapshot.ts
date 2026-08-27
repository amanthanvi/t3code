import type {
  ProviderDriverKind,
  ModelCapabilities,
  RuntimeMode,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { normalizeCustomModelSlug } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { isWindowsCommandNotFound } from "../processRunner.ts";
import { createProviderVersionAdvisory } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Auth status checks involve disk/network lookups and can be slow on first run (especially Windows)
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ProviderCommandNotFoundError extends Schema.TaggedErrorClass<ProviderCommandNotFoundError>()(
  "ProviderCommandNotFoundError",
  {
    binaryPath: Schema.String,
    exitCode: Schema.Number,
    stdoutLength: Schema.Number,
    stderrLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider command ${this.binaryPath} was not found (exit code ${this.exitCode}).`;
  }
}

const isProviderCommandNotFoundError = Schema.is(ProviderCommandNotFoundError);

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

export interface ServerProviderPresentation {
  readonly displayName: string;
  readonly badgeLabel?: string;
  readonly showInteractionModeToggle?: boolean;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly supportsImageAttachments?: boolean;
  readonly requiresNewThreadForModelChange?: boolean;
}

export type ServerProviderDraft = Omit<ServerProvider, "instanceId" | "driver">;

/**
 * Stamp a driver-agnostic snapshot draft with the identity of the instance
 * that produced it. Every driver applies this to its probe results before
 * publishing, so the identity fields live in exactly one place.
 */
export const withProviderInstanceIdentity =
  (input: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ServerProvider["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: input.driver,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: unknown): boolean {
  if (isProviderCommandNotFoundError(error)) return true;
  return error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound";
}

export const spawnAndCollect = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* new ProviderCommandNotFoundError({
        binaryPath,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
    }
    return result;
  }).pipe(Effect.scoped);

export function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
  customModelCapabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeCustomModelSlug(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildSelectOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly options:
    | ReadonlyArray<{
        value: string;
        label: string;
        description?: string | undefined;
        isDefault?: boolean | undefined;
      }>
    | undefined;
  readonly description?: string;
  readonly promptInjectedValues?: ReadonlyArray<string>;
}) {
  const options = (input.options ?? []).map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.isDefault ? { isDefault: true } : {}),
  }));
  const currentValue = options.find((option) => option.isDefault)?.id;
  return {
    id: input.id,
    label: input.label,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.promptInjectedValues && input.promptInjectedValues.length > 0
      ? { promptInjectedValues: [...input.promptInjectedValues] }
      : {}),
  };
}

export function buildBooleanOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly currentValue?: boolean;
  readonly description?: string;
}) {
  return {
    id: input.id,
    label: input.label,
    type: "boolean" as const,
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.currentValue === "boolean" ? { currentValue: input.currentValue } : {}),
  };
}

export function buildServerProvider(input: {
  driver?: ProviderDriverKind;
  presentation: ServerProviderPresentation;
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  probe: ProviderProbeResult;
}): ServerProviderDraft {
  const versionAdvisory = input.driver
    ? createProviderVersionAdvisory({
        driver: input.driver,
        currentVersion: input.probe.version,
        checkedAt: input.checkedAt,
      })
    : undefined;
  return {
    displayName: input.presentation.displayName,
    ...(input.presentation.badgeLabel ? { badgeLabel: input.presentation.badgeLabel } : {}),
    ...(typeof input.presentation.showInteractionModeToggle === "boolean"
      ? { showInteractionModeToggle: input.presentation.showInteractionModeToggle }
      : {}),
    ...(input.presentation.supportedRuntimeModes
      ? { supportedRuntimeModes: [...input.presentation.supportedRuntimeModes] }
      : {}),
    ...(typeof input.presentation.supportsImageAttachments === "boolean"
      ? { supportsImageAttachments: input.presentation.supportsImageAttachments }
      : {}),
    ...(typeof input.presentation.requiresNewThreadForModelChange === "boolean"
      ? { requiresNewThreadForModelChange: input.presentation.requiresNewThreadForModelChange }
      : {}),
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    models: input.models,
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
    ...(versionAdvisory ? { versionAdvisory } : {}),
  };
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  collectUint8StreamText({ stream }).pipe(Effect.map((collected) => collected.text));

export const VERSION_PROBE_TIMEOUT_MS = 4_000;

export const runCliVersionCommand = Effect.fn("runCliVersionCommand")(function* (input: {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly forceKillAfter?: Duration.Input | undefined;
}) {
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, ["--version"], {
    env: input.environment,
  });
  return yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: input.environment,
      ...(input.forceKillAfter !== undefined ? { forceKillAfter: input.forceKillAfter } : {}),
      shell: spawnCommand.shell,
    }),
  );
});

export type CliVersionProbeOutcome =
  | { readonly kind: "unavailable"; readonly draft: ServerProviderDraft }
  | { readonly kind: "ok"; readonly version: string | null };

/**
 * The health-check stages every CLI provider shares: disabled
 * short-circuit, version probe with timeout, missing-binary detection, and
 * non-zero exit handling. Providers run their own model/auth discovery
 * after an `"ok"` outcome and build the final snapshot themselves.
 */
export const probeCliProviderVersion = Effect.fn("probeCliProviderVersion")(function* <
  E extends { readonly _tag: string },
  R,
>(input: {
  readonly presentation: ServerProviderPresentation;
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly fallbackModels: ReadonlyArray<ServerProviderModel>;
  readonly defaultBinary: string;
  /** Appended to the standard missing-binary message, e.g. an install hint. */
  readonly notInstalledHint?: string | undefined;
  readonly runVersionCommand: Effect.Effect<CommandResult, E, R>;
}) {
  const { presentation, enabled, checkedAt, fallbackModels } = input;
  const label = `${presentation.displayName} CLI`;
  const unavailable = (probe: ProviderProbeResult): CliVersionProbeOutcome => ({
    kind: "unavailable",
    draft: buildServerProvider({ presentation, enabled, checkedAt, models: fallbackModels, probe }),
  });

  if (!enabled) {
    return unavailable({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: `${presentation.displayName} is disabled in T3 Code settings.`,
    });
  }

  const versionResult = yield* input.runVersionCommand.pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning(`${label} health check failed.`, { errorTag: error._tag });
    return unavailable({
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? `${label} (\`${input.defaultBinary}\`) is not installed or not on PATH.${
            input.notInstalledHint ? ` ${input.notInstalledHint}` : ""
          }`
        : `Failed to execute ${label} health check.`,
    });
  }

  if (Option.isNone(versionResult.success)) {
    return unavailable({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `${label} is installed but timed out while running \`${input.defaultBinary} --version\`.`,
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning(`${label} version probe exited with a non-zero status.`, {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return unavailable({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `${label} is installed but failed to run.`,
    });
  }

  return { kind: "ok", version } satisfies CliVersionProbeOutcome;
});
