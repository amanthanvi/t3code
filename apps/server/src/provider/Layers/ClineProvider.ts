import {
  type ClineSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  probeCliProviderVersion,
  runCliVersionCommand,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  CLINE_PROCESS_FORCE_KILL_AFTER,
  clineModelsFromSessionConfigOptions,
  makeClineAcpRuntime,
} from "../acp/ClineAcpSupport.ts";
import { startAcpRuntimeWithTimeout as startClineAcpRuntimeWithTimeout } from "../acp/AcpSessionRuntime.ts";

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

  const versionProbe = yield* probeCliProviderVersion({
    presentation: CLINE_PRESENTATION,
    enabled: clineSettings.enabled,
    checkedAt,
    fallbackModels,
    defaultBinary: "cline",
    notInstalledHint: "Install it with `npm install -g cline`.",
    runVersionCommand: runCliVersionCommand({
      binaryPath: clineSettings.binaryPath || "cline",
      environment,
      forceKillAfter: CLINE_PROCESS_FORCE_KILL_AFTER,
    }),
  });
  if (versionProbe.kind === "unavailable") {
    return versionProbe.draft;
  }
  const version = versionProbe.version;

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
