/**
 * Provider capability gating shared by the web and mobile clients.
 *
 * The rules read the session capabilities advertised on the
 * `ServerProvider` snapshot (`supportedRuntimeModes`,
 * `showInteractionModeToggle`, `supportsImageAttachments`). Both clients
 * must present the same copy for the same restriction, so the strings live
 * here exactly once; each app keeps only a thin lookup wrapper for its own
 * input shape.
 */
import {
  ALL_RUNTIME_MODES,
  PROVIDER_DISPLAY_NAMES,
  isProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * The snapshot fields the gating rules read. Structural so both the full
 * `ServerProvider` and the clients' narrowed provider views satisfy it.
 */
export type ProviderCapabilitySnapshot = Pick<
  ServerProvider,
  | "displayName"
  | "driver"
  | "supportedRuntimeModes"
  | "showInteractionModeToggle"
  | "supportsImageAttachments"
>;

export function formatProviderDriverKindLabel(driver: string): string {
  return driver
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function providerCapabilityLabel(
  provider: Pick<ProviderCapabilitySnapshot, "displayName" | "driver"> | null | undefined,
): string {
  if (!provider) {
    return "This provider";
  }
  const displayName = provider.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const builtIn = isProviderDriverKind(provider.driver)
    ? PROVIDER_DISPLAY_NAMES[provider.driver]
    : undefined;
  return builtIn ?? formatProviderDriverKindLabel(provider.driver);
}

export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function getProviderSupportedRuntimeModes(
  provider: Pick<ProviderCapabilitySnapshot, "supportedRuntimeModes"> | null | undefined,
): ReadonlyArray<RuntimeMode> {
  return provider?.supportedRuntimeModes ?? ALL_RUNTIME_MODES;
}

/**
 * Suggest the mode the user should switch to. Prefers full access (the
 * least restricted, and what every current limited provider requires) but
 * falls back to whatever the provider actually supports, so the copy stays
 * truthful for a future provider with a different restriction.
 */
function suggestedRuntimeModeLabel(supported: ReadonlyArray<RuntimeMode>): string {
  const suggested = supported.includes("full-access") ? "full-access" : supported[0];
  return RUNTIME_MODE_LABELS[suggested ?? "full-access"];
}

export function getUnsupportedProviderModeReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): string | null {
  const label = providerCapabilityLabel(input.provider);
  const supported = getProviderSupportedRuntimeModes(input.provider);
  if (!supported.includes(input.runtimeMode)) {
    return `${label} does not support the selected access mode. Choose ${suggestedRuntimeModeLabel(supported)} to continue.`;
  }
  if (input.interactionMode === "plan" && input.provider?.showInteractionModeToggle === false) {
    return `${label} does not support Plan mode. Choose Build to continue.`;
  }
  return null;
}

export function getUnsupportedProviderAttachmentReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly attachmentCount: number;
}): string | null {
  if (input.attachmentCount === 0 || input.provider?.supportsImageAttachments !== false) {
    return null;
  }
  return `${providerCapabilityLabel(input.provider)} does not support image attachments. Remove the images to continue.`;
}

/**
 * Whether the Build/Plan toggle is offered. Always offered while already
 * in Plan mode so the user can leave it even on a provider that cannot
 * enter it.
 */
export function providerShowsInteractionModeToggle(
  provider: Pick<ProviderCapabilitySnapshot, "showInteractionModeToggle"> | null | undefined,
  interactionMode: ProviderInteractionMode,
): boolean {
  return interactionMode === "plan" || provider?.showInteractionModeToggle !== false;
}
