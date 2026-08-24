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

export function updateProviderInputSubmissionError(
  error: string | null,
  event:
    | {
        readonly type: "blocked-submit";
        readonly effectiveSendDisabledReason: string | null;
      }
    | {
        readonly type: "effective-send-disabled-reason-changed";
        readonly previousEffectiveSendDisabledReason: string | null;
        readonly effectiveSendDisabledReason: string | null;
      },
): string | null {
  if (event.type === "blocked-submit") return event.effectiveSendDisabledReason;
  return event.previousEffectiveSendDisabledReason === event.effectiveSendDisabledReason
    ? error
    : null;
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
