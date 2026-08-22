export function getFallbackProviderModelLabel(model: string): string {
  return model.trim() || "No model available";
}

export function hasSelectableProviderModel(model: string): boolean {
  return model.trim().length > 0;
}
