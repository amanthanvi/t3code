import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
export const ALL_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export function formatProviderDriverKindLabel(provider: ProviderDriverKind): string {
  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return getProviderSnapshot(providers, provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): ServerProvider | undefined {
  const defaultInstanceId = defaultInstanceIdForDriver(provider);
  return providers.find((candidate) => candidate.instanceId === defaultInstanceId);
}

export function getProviderDisplayName(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const snapshot = getProviderSnapshot(providers, provider);
  return snapshot?.displayName?.trim() || formatProviderDriverKindLabel(provider);
}

export function getProviderInteractionModeToggle(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.showInteractionModeToggle ?? true;
}

export function getProviderSupportedRuntimeModes(
  provider: ServerProvider | null | undefined,
): ReadonlyArray<RuntimeMode> {
  return provider?.supportedRuntimeModes ?? ALL_RUNTIME_MODES;
}

export function getUnsupportedProviderModeReason(input: {
  readonly provider: ServerProvider | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: "default" | "plan";
}): string | null {
  const label =
    input.provider?.displayName?.trim() ||
    (input.provider ? formatProviderDriverKindLabel(input.provider.driver) : "This provider");
  if (!getProviderSupportedRuntimeModes(input.provider).includes(input.runtimeMode)) {
    return `${label} does not support the selected access mode. Choose Full access to continue.`;
  }
  if (input.interactionMode === "plan" && input.provider?.showInteractionModeToggle === false) {
    return `${label} does not support Plan mode. Choose Build to continue.`;
  }
  return null;
}

export function canUseProviderInteractionModeShortcut(input: {
  readonly planModeUiEnabled: boolean;
  readonly showInteractionModeToggle: boolean;
  readonly interactionMode: "default" | "plan";
}): boolean {
  return (
    input.planModeUiEnabled && (input.showInteractionModeToggle || input.interactionMode === "plan")
  );
}

export function getUnsupportedProviderAttachmentReason(
  provider: ServerProvider | null | undefined,
  attachmentCount: number,
): string | null {
  if (attachmentCount === 0 || provider?.supportsImageAttachments !== false) {
    return null;
  }
  const label = provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver);
  return `${label} does not support image attachments. Remove the images to continue.`;
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): boolean {
  if (providers.length === 0) {
    return true;
  }
  return getProviderSnapshot(providers, provider)?.enabled ?? false;
}

// Resolve an instance selection to the correlated live driver. If the
// instance is absent, fall back to a live enabled provider instead of
// inferring a driver from the missing instance id.
export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind | ProviderInstanceId | null | undefined,
): ProviderDriverKind {
  const requestedEntry = providers.find((candidate) => candidate.instanceId === provider);
  if (requestedEntry?.enabled) {
    return requestedEntry.driver;
  }
  return providers.find((candidate) => candidate.enabled)?.driver ?? DEFAULT_DRIVER_KIND;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderDriverKind,
  planModeEnabled = true,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  const caps =
    models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
  if (planModeEnabled) {
    return caps;
  }
  return withoutPlanAgentOption(caps);
}

// The opencode "plan" agent is only reachable while legacy plan mode is on.
// With it off, drop the option so it cannot be selected or dispatched, and
// drop the descriptor entirely when nothing remains selectable. currentValue
// is re-resolved against the surviving options so a stale or defaulted "plan"
// value cannot leak back into dispatch.
function withoutPlanAgentOption(caps: ModelCapabilities): ModelCapabilities {
  return {
    ...caps,
    optionDescriptors: (caps.optionDescriptors ?? []).flatMap((descriptor) => {
      if (descriptor.type !== "select" || descriptor.id !== "agent") {
        return [descriptor];
      }
      const options = descriptor.options.filter((option) => option.id !== "plan");
      if (options.length === 0) {
        return [];
      }
      const currentValue =
        descriptor.currentValue && options.some((option) => option.id === descriptor.currentValue)
          ? descriptor.currentValue
          : (options.find((option) => option.isDefault)?.id ?? options[0]?.id);
      return [{ ...descriptor, options, ...(currentValue ? { currentValue } : {}) }];
    }),
  };
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderDriverKind,
): string {
  const models = getProviderModels(providers, provider);
  if (provider === "cline" && models.length === 0) {
    // Cline's model catalog is account-scoped. An empty catalog is an
    // actionable provider error, not a reason to synthesize a Codex model.
    return "";
  }
  return (
    models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider] ??
    DEFAULT_MODEL
  );
}
