import { describe, expect, it } from "vite-plus/test";

import {
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
