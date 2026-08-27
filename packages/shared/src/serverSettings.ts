import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isProviderDriverKind,
  isProviderAvailable,
  providerDriverSupportsTextGeneration,
  providerSupportsTextGeneration,
  resolveProviderInstanceEnabled,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

function resolveModelSelectionDriver(
  settings: ServerSettings,
  selection: ModelSelection,
): ProviderDriverKind | undefined {
  const instance = settings.providerInstances[selection.instanceId];
  if (instance !== undefined) return instance.driver;
  return isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId) !== undefined
    ? selection.instanceId
    : undefined;
}

/**
 * Settings-time capability check: runs before any provider probe, so it can
 * only consult the contracts-level driver fact. Built-in snapshots derive
 * their `supportsTextGeneration` flag from the same fact (see
 * `KILO_PRESENTATION`), so the two layers cannot disagree for built-ins;
 * snapshot-aware callers additionally honor a fork driver's own flag.
 */
export function isModelSelectionTextGenerationSupported(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const driver = resolveModelSelectionDriver(settings, selection);
  return driver !== undefined && providerDriverSupportsTextGeneration(driver);
}

function defaultTextGenerationSelection(
  instanceId: ModelSelection["instanceId"],
  driver: ProviderDriverKind,
): ModelSelection {
  return createModelSelection(
    instanceId,
    DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  );
}

/**
 * Find an actually enabled text-generation-capable instance. Explicit default
 * instances shadow their legacy mirror even when disabled, while enabled
 * custom instances remain eligible. Known driver kinds win over unknown
 * (fork) drivers: an unknown driver may have no registered implementation in
 * this build, and a known-driver instance is a certain backend.
 */
export function findEnabledTextGenerationFallback(
  settings: ServerSettings,
): ModelSelection | undefined {
  // Membership in the legacy per-driver settings struct identifies built-in
  // driver kinds; `isProviderDriverKind` only validates the slug shape.
  const isBuiltInDriver = (driver: ProviderDriverKind) =>
    getLegacyProviderSettings(settings, driver) !== undefined;
  const instanceEntries = Object.entries(settings.providerInstances);
  const orderedInstanceEntries = [
    ...instanceEntries.filter(([, instance]) => isBuiltInDriver(instance.driver)),
    ...instanceEntries.filter(([, instance]) => !isBuiltInDriver(instance.driver)),
  ];
  for (const [rawInstanceId, instance] of orderedInstanceEntries) {
    if (
      resolveProviderInstanceEnabled(instance) &&
      providerDriverSupportsTextGeneration(instance.driver)
    ) {
      return defaultTextGenerationSelection(
        ProviderInstanceId.make(rawInstanceId),
        instance.driver,
      );
    }
  }

  for (const [rawDriver, provider] of Object.entries(settings.providers)) {
    const driver = ProviderDriverKind.make(rawDriver);
    if (
      settings.providerInstances[ProviderInstanceId.make(rawDriver)] !== undefined ||
      !provider.enabled ||
      !providerDriverSupportsTextGeneration(driver)
    ) {
      continue;
    }
    return defaultTextGenerationSelection(ProviderInstanceId.make(rawDriver), driver);
  }
  return undefined;
}

export function resolveTextGenerationModelSelection(settings: ServerSettings): ModelSelection {
  const selection = settings.textGenerationModelSelection;
  return isModelSelectionProviderEnabled(settings, selection) &&
    isModelSelectionTextGenerationSupported(settings, selection)
    ? selection
    : (findEnabledTextGenerationFallback(settings) ?? selection);
}

export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers?: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const defaultSelection = resolveTextGenerationModelSelection(settings);
  const selection = settings.sourceControlWriterModelSelection;
  if (
    !selection ||
    !isModelSelectionProviderEnabled(settings, selection) ||
    !isModelSelectionTextGenerationSupported(settings, selection)
  ) {
    return defaultSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true &&
    isProviderAvailable(provider) &&
    providerSupportsTextGeneration(provider)
    ? selection
    : defaultSelection;
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacementsBase = {
    ...next,
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
