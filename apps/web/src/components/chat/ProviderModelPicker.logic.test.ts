import { describe, expect, it } from "vite-plus/test";

import {
  getComposerProviderAvailability,
  getFallbackProviderModelLabel,
  hasSelectableProviderModel,
} from "./ProviderModelPicker.logic";

describe("getFallbackProviderModelLabel", () => {
  it("presents an empty provider model state without exposing an internal value", () => {
    expect(getFallbackProviderModelLabel("")).toBe("No model available");
    expect(getFallbackProviderModelLabel("  ")).toBe("No model available");
    expect(getFallbackProviderModelLabel("composer-2")).toBe("composer-2");
  });

  it("treats an empty model as unavailable for composer submission", () => {
    expect(hasSelectableProviderModel("")).toBe(false);
    expect(hasSelectableProviderModel("  ")).toBe(false);
    expect(hasSelectableProviderModel("composer-2")).toBe(true);
  });
});

describe("getComposerProviderAvailability", () => {
  it("keeps the picker mounted while an available provider reports an empty catalog", () => {
    expect(
      getComposerProviderAvailability({
        hasProviderEntry: true,
        selectedModel: "",
      }),
    ).toEqual({
      noProviderEntryAvailable: false,
      noSelectableModelAvailable: true,
      noProviderAvailable: true,
      showProviderModelPicker: true,
    });
  });

  it("replaces the picker only when there is no provider entry", () => {
    expect(
      getComposerProviderAvailability({
        hasProviderEntry: false,
        selectedModel: "",
      }).showProviderModelPicker,
    ).toBe(false);
  });
});
