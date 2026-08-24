import type {
  ModelCapabilities,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

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
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode>;
  readonly showInteractionModeToggle: boolean;
  readonly supportsImageAttachments: boolean;
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

export const ALL_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export function getUnsupportedProviderModeReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): string | null {
  const provider = input.config?.providers.find(
    (candidate) => candidate.instanceId === input.selection?.instanceId,
  );
  if (!provider) return null;
  const supported = provider.supportedRuntimeModes ?? ALL_RUNTIME_MODES;
  if (!supported.includes(input.runtimeMode)) {
    return `${providerDisplayLabel(provider)} does not support the selected access mode. Choose Full access to continue.`;
  }
  if (input.interactionMode === "plan" && provider.showInteractionModeToggle === false) {
    return `${providerDisplayLabel(provider)} does not support Plan mode. Choose Build to continue.`;
  }
  return null;
}

export function shouldShowProviderInteractionModeToggle(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly interactionMode: ProviderInteractionMode;
}): boolean {
  if (input.interactionMode === "plan") {
    return true;
  }
  const provider = input.config?.providers.find(
    (candidate) => candidate.instanceId === input.selection?.instanceId,
  );
  return provider?.showInteractionModeToggle !== false;
}

export function getUnsupportedProviderAttachmentReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly attachmentCount: number;
}): string | null {
  if (input.attachmentCount === 0) return null;
  const provider = input.config?.providers.find(
    (candidate) => candidate.instanceId === input.selection?.instanceId,
  );
  if (provider?.supportsImageAttachments !== false) return null;
  return `${providerDisplayLabel(provider)} does not support image attachments. Remove the images to continue.`;
}

export function providerSupportsImageAttachments(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
}): boolean {
  const provider = input.config?.providers.find(
    (candidate) => candidate.instanceId === input.selection?.instanceId,
  );
  return provider?.supportsImageAttachments !== false;
}

export function getProviderSendBlockReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly attachmentCount: number;
}): string | null {
  return (
    getUnavailableProviderModelReason(input) ??
    getUnsupportedProviderModeReason(input) ??
    getUnsupportedProviderAttachmentReason(input)
  );
}

export function getUnavailableProviderModelReason(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly selection: ModelSelection | null | undefined;
}): string | null {
  const provider = input.config?.providers.find(
    (candidate) => candidate.instanceId === input.selection?.instanceId,
  );
  if (
    provider?.driver !== "cline" ||
    provider.models.some((candidate) => candidate.slug === input.selection?.model)
  ) {
    return null;
  }
  if (provider.status === "warning" && provider.auth.status === "unknown") {
    return `${providerDisplayLabel(provider)} is still checking its model catalog. Wait for the provider check to finish.`;
  }
  return `${providerDisplayLabel(provider)} no longer offers the selected model. Choose another model to continue.`;
}

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  return provider.instanceId;
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

function hasUnadvertisedClineSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection,
): boolean {
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  return (
    provider?.driver === "cline" &&
    !(provider.status === "warning" && provider.auth.status === "unknown") &&
    !provider.models.some((candidate) => candidate.slug === selection.model)
  );
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
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
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
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
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

    const providerLabel = providerDisplayLabel(provider);
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
        supportedRuntimeModes: provider.supportedRuntimeModes ?? ALL_RUNTIME_MODES,
        showInteractionModeToggle: provider.showInteractionModeToggle ?? true,
        supportsImageAttachments: provider.supportsImageAttachments ?? true,
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

  const fallbackProvider = config?.providers.find(
    (provider) => provider.instanceId === fallbackModelSelection?.instanceId,
  );
  const canInjectFallback =
    fallbackProvider?.driver !== "cline" ||
    fallbackProvider.models.some((model) => model.slug === fallbackModelSelection?.model);
  if (
    fallbackModelSelection &&
    canInjectFallback &&
    !hasUnadvertisedClineSelection(config, fallbackModelSelection)
  ) {
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
        supportedRuntimeModes: ALL_RUNTIME_MODES,
        showInteractionModeToggle: true,
        supportsImageAttachments: true,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<
    string,
    {
      providerLabel: string;
      supportedRuntimeModes: ReadonlyArray<RuntimeMode>;
      showInteractionModeToggle: boolean;
      supportsImageAttachments: boolean;
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
        supportedRuntimeModes: option.supportedRuntimeModes,
        showInteractionModeToggle: option.showInteractionModeToggle,
        supportsImageAttachments: option.supportsImageAttachments,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    supportedRuntimeModes: group.supportedRuntimeModes,
    showInteractionModeToggle: group.showInteractionModeToggle,
    supportsImageAttachments: group.supportsImageAttachments,
    models: group.models,
  }));
}
