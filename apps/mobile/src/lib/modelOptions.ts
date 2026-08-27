import {
  getProviderDriverCapabilities,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  getProviderSupportedRuntimeModes,
  getUnsupportedProviderAttachmentReason as sharedUnsupportedProviderAttachmentReason,
  getUnsupportedProviderModeReason as sharedUnsupportedProviderModeReason,
  providerCapabilityLabel,
  providerShowsInteractionModeToggle,
} from "@t3tools/shared/providerCapabilities";

type ConfiguredProvider = T3ServerConfig["providers"][number];

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode>;
  readonly showInteractionModeToggle: boolean;
  readonly supportsImageAttachments: boolean;
  readonly models: ReadonlyArray<ModelOption>;
};

function findProvider(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): ConfiguredProvider | undefined {
  return config?.providers.find((candidate) => candidate.instanceId === selection?.instanceId);
}

export function getUnsupportedProviderModeReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): string | null {
  const provider = findProvider(input.config, input.selection);
  if (!provider) return null;
  return sharedUnsupportedProviderModeReason({
    provider,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
  });
}

export function shouldShowProviderInteractionModeToggle(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly interactionMode: ProviderInteractionMode;
}): boolean {
  return providerShowsInteractionModeToggle(
    findProvider(input.config, input.selection),
    input.interactionMode,
  );
}

export function getUnsupportedProviderAttachmentReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly attachmentCount: number;
}): string | null {
  return sharedUnsupportedProviderAttachmentReason({
    provider: findProvider(input.config, input.selection),
    attachmentCount: input.attachmentCount,
  });
}

export function providerSupportsImageAttachments(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
}): boolean {
  return findProvider(input.config, input.selection)?.supportsImageAttachments !== false;
}

export function getProviderSendBlockReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly attachmentCount: number;
}): string | null {
  return getProviderSendBlockAlert(input)?.message ?? null;
}

/**
 * The first reason the provider would reject this send, paired with the
 * alert title matching its kind. Single source for every send-gate alert so
 * the composer, the new-task editor, and the outbox agree on copy.
 */
export function getProviderSendBlockAlert(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly attachmentCount: number;
}): { readonly title: string; readonly message: string } | null {
  const unavailableModelReason = getUnavailableProviderModelReason(input);
  if (unavailableModelReason !== null) {
    return { title: "Provider still checking", message: unavailableModelReason };
  }
  const unsupportedModeReason = getUnsupportedProviderModeReason(input);
  if (unsupportedModeReason !== null) {
    return { title: "Change provider mode", message: unsupportedModeReason };
  }
  const unsupportedAttachmentReason = getUnsupportedProviderAttachmentReason(input);
  if (unsupportedAttachmentReason !== null) {
    return { title: "Remove attachments", message: unsupportedAttachmentReason };
  }
  return null;
}

/**
 * Whether `selection` names a model outside the provider's advertised
 * catalog on a driver whose catalog is authoritative (e.g. Cline's
 * account-scoped catalog). Such selections must be blocked rather than
 * dispatched or backfilled with synthesized defaults.
 */
function hasUnadvertisedAuthoritativeCatalogSelection(
  provider: ConfiguredProvider | undefined,
  selection: ModelSelection | null | undefined,
): boolean {
  return (
    provider !== undefined &&
    getProviderDriverCapabilities(provider.driver).modelCatalogIsAuthoritative &&
    !provider.models.some((candidate) => candidate.slug === selection?.model)
  );
}

export function getUnavailableProviderModelReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
}): string | null {
  const provider = findProvider(input.config, input.selection);
  if (!hasUnadvertisedAuthoritativeCatalogSelection(provider, input.selection)) {
    return null;
  }
  if (provider?.status === "warning" && provider.auth.status === "unknown") {
    return `${providerCapabilityLabel(provider)} is still checking its model catalog. Wait for the provider check to finish.`;
  }
  return `${providerCapabilityLabel(provider)} no longer offers the selected model. Choose another model to continue.`;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, and authenticated on the server. Returns the
 * selection unchanged when usable, otherwise `null` so callers fall through to
 * the server's default model. A usable Cline instance keeps an unadvertised
 * selection intact so the UI can identify and block the stale model without
 * silently rerouting the draft. A missing config (environment offline) cannot
 * be validated, so stored selections pass through untouched.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = findProvider(config, selection);
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

/**
 * Like resolveSelectableModelSelection, but additionally rejects legacy
 * models. Used for implicit defaults (stored draft, project last-used): a
 * new thread should never quietly start on a legacy model, so those fall
 * through to the provider's default instead. Explicit picks in the settings
 * sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = findProvider(config, usable);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return model?.isLegacy === true ? null : usable;
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const providerLabel = providerCapabilityLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  const fallbackProvider = findProvider(config, fallbackModelSelection);
  const canInjectFallback = !hasUnadvertisedAuthoritativeCatalogSelection(
    fallbackProvider,
    fallbackModelSelection,
  );
  if (fallbackModelSelection && canInjectFallback) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: fallbackModelSelection.instanceId,
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(
  options: ReadonlyArray<ModelOption>,
  config: T3ServerConfig | null | undefined,
): ReadonlyArray<ProviderGroup> {
  const groups = new Map<
    string,
    {
      providerLabel: string;
      models: ModelOption[];
    }
  >();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => {
    // A fallback-injected group's provider may be absent from the config
    // (environment offline); the shared helpers then grant every capability,
    // matching how such selections were treated before.
    const provider = config?.providers.find((candidate) => candidate.instanceId === providerKey);
    return {
      providerKey,
      providerLabel: group.providerLabel,
      supportedRuntimeModes: getProviderSupportedRuntimeModes(provider),
      showInteractionModeToggle: provider?.showInteractionModeToggle ?? true,
      supportsImageAttachments: provider?.supportsImageAttachments ?? true,
      models: group.models,
    };
  });
}
