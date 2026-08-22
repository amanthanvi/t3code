import {
  type ClineSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  CLINE_PROCESS_FORCE_KILL_AFTER,
  clineModelsFromSessionConfigOptions,
  makeClineAcpRuntime,
  startClineAcpRuntimeWithTimeout,
} from "../acp/ClineAcpSupport.ts";

const CLINE_PRESENTATION = {
  displayName: "Cline",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["full-access"],
  supportsImageAttachments: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const CLINE_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

export const buildInitialClineProviderSnapshot = Effect.fn("buildInitialClineProviderSnapshot")(
  function* (clineSettings: ClineSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models: ReadonlyArray<ServerProviderModel> = [];

    if (!clineSettings.enabled) {
      return buildServerProvider({
        presentation: CLINE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cline is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Cline CLI availability...",
      },
    });
  },
);

export type ClineDiscoveryOutcome =
  | { readonly kind: "ok"; readonly models: ReadonlyArray<ServerProviderModel> }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "failed"; readonly errorTag: string };

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const CLINE_SESSION_SETUP_METHODS = new Set(["session/new", "session/load", "session/resume"]);
const CLINE_AUTH_REQUIRED_MESSAGE = /authenticat|sign(?:ed)?[ -]?in|credential|api[ _-]?key/i;

export const classifyClineDiscoveryFailure = (
  cause: Cause.Cause<EffectAcpErrors.AcpError>,
): ClineDiscoveryOutcome => {
  const error = Cause.findErrorOption(cause);
  if (
    Option.isSome(error) &&
    isAcpRequestError(error.value) &&
    error.value.code === -32000 &&
    error.value.method !== undefined &&
    CLINE_SESSION_SETUP_METHODS.has(error.value.method) &&
    CLINE_AUTH_REQUIRED_MESSAGE.test(error.value.errorMessage)
  ) {
    return { kind: "unauthenticated" };
  }
  return { kind: "failed", errorTag: causeErrorTag(cause) };
};

const discoverClineModelsViaAcp = Effect.fn("discoverClineModelsViaAcp")(function* (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv = process.env,
  timeout: Duration.Input = CLINE_ACP_MODEL_DISCOVERY_TIMEOUT_MS,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const acp = yield* makeClineAcpRuntime({
      clineSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      forceKillAfter: CLINE_PROCESS_FORCE_KILL_AFTER,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });

    const started = yield* startClineAcpRuntimeWithTimeout({
      runtime: acp,
      timeout,
      forceKillAfter: CLINE_PROCESS_FORCE_KILL_AFTER,
    });

    if (Option.isNone(started)) {
      return { kind: "failed", errorTag: "Timeout" } satisfies ClineDiscoveryOutcome;
    }

    const models = clineModelsFromSessionConfigOptions(started.value.sessionSetupResult).map(
      (model): ServerProviderModel => ({
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
        ...(model.isDefault ? { isDefault: true } : {}),
      }),
    );
    return { kind: "ok", models } satisfies ClineDiscoveryOutcome;
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed(classifyClineDiscoveryFailure(cause))),
    Effect.scoped,
  );
});

const runClineVersionCommand = Effect.fn("runClineVersionCommand")(function* (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const command = clineSettings.binaryPath || "cline";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
    env: environment,
  });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      forceKillAfter: CLINE_PROCESS_FORCE_KILL_AFTER,
      shell: spawnCommand.shell,
    }),
  );
});

export const checkClineProviderStatus = Effect.fn("checkClineProviderStatus")(function* (
  clineSettings: ClineSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly acpModelDiscoveryTimeout?: Duration.Input },
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels: ReadonlyArray<ServerProviderModel> = [];

  if (!clineSettings.enabled) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cline is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runClineVersionCommand(clineSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Cline CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Cline CLI (`cline`) is not installed or not on PATH. Install it with `npm install -g cline`."
          : "Failed to execute Cline CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but timed out while running `cline --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Cline CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but failed to run.",
      },
    });
  }

  const outcome = yield* discoverClineModelsViaAcp(
    clineSettings,
    environment,
    options?.acpModelDiscoveryTimeout,
  );
  if (outcome.kind === "unauthenticated") {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "Cline CLI is installed but not signed in. Run `cline auth` in a terminal, then re-check.",
      },
    });
  }
  if (outcome.kind === "failed") {
    yield* Effect.logWarning("Cline ACP model discovery failed", {
      errorTag: outcome.errorTag,
    });
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Cline CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }

  const models = outcome.models;

  if (models.length === 0) {
    return buildServerProvider({
      presentation: CLINE_PRESENTATION,
      enabled: clineSettings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "authenticated" },
        message:
          "Cline is signed in but did not advertise any usable models. Configure a provider and model in Cline, then re-check.",
      },
    });
  }

  return buildServerProvider({
    presentation: CLINE_PRESENTATION,
    enabled: clineSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

export const enrichClineSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Cline version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
