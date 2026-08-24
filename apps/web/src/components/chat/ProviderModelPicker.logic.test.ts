import { describe, expect, it } from "vite-plus/test";

import {
  getComposerProviderAvailability,
  getFallbackProviderModelLabel,
  getNoSelectableProviderModelReason,
  hasSelectableProviderModel,
  updateProviderInputSubmissionError,
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

  it("provides an actionable disabled reason for an empty provider catalog", () => {
    expect(getNoSelectableProviderModelReason(true)).toBe("No models available for this provider");
    expect(getNoSelectableProviderModelReason(false)).toBeNull();
  });

  it("clears a blocked-submit error when the provider mode is corrected", () => {
    const blockedReason =
      "Cline does not support the selected access mode. Choose Full access to continue.";
    const error = updateProviderInputSubmissionError(null, {
      type: "blocked-submit",
      effectiveSendDisabledReason: blockedReason,
    });
    expect(error).toBe(blockedReason);
    expect(
      updateProviderInputSubmissionError(error, {
        type: "effective-send-disabled-reason-changed",
        previousEffectiveSendDisabledReason: blockedReason,
        effectiveSendDisabledReason: null,
      }),
    ).toBeNull();
  });

  it("clears a blocked-submit error when an unsupported image is removed", () => {
    const blockedReason =
      "Cline does not support image attachments. Remove the images to continue.";
    const error = updateProviderInputSubmissionError(null, {
      type: "blocked-submit",
      effectiveSendDisabledReason: blockedReason,
    });
    expect(error).toBe(blockedReason);
    expect(
      updateProviderInputSubmissionError(error, {
        type: "effective-send-disabled-reason-changed",
        previousEffectiveSendDisabledReason: blockedReason,
        effectiveSendDisabledReason: null,
      }),
    ).toBeNull();
  });

  it("retains a blocked-submit error while its reason is unchanged", () => {
    const blockedReason = "No models available for this provider";
    expect(
      updateProviderInputSubmissionError(blockedReason, {
        type: "effective-send-disabled-reason-changed",
        previousEffectiveSendDisabledReason: blockedReason,
        effectiveSendDisabledReason: blockedReason,
      }),
    ).toBe(blockedReason);
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
