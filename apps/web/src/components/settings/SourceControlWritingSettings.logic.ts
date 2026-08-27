import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

/**
 * Resolves the source-control writer toggle without ever persisting the
 * local-only no-provider sentinel. `undefined` means enabling is unavailable.
 */
export function resolveSourceControlWriterToggleSelection(
  checked: boolean,
  defaultSelection: ModelSelection,
  hasTextGenerationProvider: boolean,
): ModelSelection | null | undefined {
  if (!checked) return null;
  if (!hasTextGenerationProvider) return undefined;
  return createModelSelection(
    defaultSelection.instanceId,
    defaultSelection.model,
    defaultSelection.options,
  );
}

/**
 * Keep the dedicated selection only when the shared resolver returned the
 * exact configured object. Any fallback it produced is settings-only, so the
 * already live-resolved general selection remains authoritative in the UI.
 */
export function resolveActiveSourceControlWriterSelection(
  resolvedSelection: ModelSelection,
  dedicatedSelection: ModelSelection | null,
  defaultSelection: ModelSelection,
): ModelSelection {
  return resolvedSelection === dedicatedSelection ? resolvedSelection : defaultSelection;
}
