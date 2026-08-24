export function getFallbackProviderModelLabel(model: string): string {
  return model.trim() || "No model available";
}

export function hasSelectableProviderModel(model: string): boolean {
  return model.trim().length > 0;
}

export function getNoSelectableProviderModelReason(
  noSelectableModelAvailable: boolean,
): string | null {
  return noSelectableModelAvailable ? "No models available for this provider" : null;
}

export function getComposerProviderAvailability(input: {
  readonly hasProviderEntry: boolean;
  readonly selectedModel: string;
}) {
  const noProviderEntryAvailable = !input.hasProviderEntry;
  const noSelectableModelAvailable =
    input.hasProviderEntry && !hasSelectableProviderModel(input.selectedModel);
  return {
    noProviderEntryAvailable,
    noSelectableModelAvailable,
    noProviderAvailable: noProviderEntryAvailable || noSelectableModelAvailable,
    showProviderModelPicker: input.hasProviderEntry,
  } as const;
}
