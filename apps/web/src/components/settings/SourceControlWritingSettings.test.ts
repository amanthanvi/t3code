import { describe, expect, it } from "vite-plus/test";

import {
  hasUsableSourceControlWriterModel,
  sourceControlWriterToggleState,
} from "./SourceControlWritingSettings";

const model = { slug: "model", name: "Model", isCustom: false, capabilities: null } as const;

describe("source control writer model toggle", () => {
  it("allows clearing a stale override when no supported model is available", () => {
    expect(
      sourceControlWriterToggleState({
        hasOverride: true,
        hasSupportedModel: false,
      }),
    ).toEqual({ checked: true, disabled: false });
  });

  it("prevents enabling a new override when no supported model is available", () => {
    expect(
      sourceControlWriterToggleState({
        hasOverride: false,
        hasSupportedModel: false,
      }),
    ).toEqual({ checked: false, disabled: true });
  });

  it("requires an enabled and available instance for a new override", () => {
    expect(
      hasUsableSourceControlWriterModel([
        { enabled: false, isAvailable: true, status: "ready", models: [model] },
        { enabled: true, isAvailable: false, status: "ready", models: [model] },
      ]),
    ).toBe(false);
    expect(
      hasUsableSourceControlWriterModel([
        { enabled: true, isAvailable: true, status: "ready", models: [model] },
      ]),
    ).toBe(true);
  });

  it("rejects errored and empty provider catalogs for a new override", () => {
    expect(
      hasUsableSourceControlWriterModel([
        { enabled: true, isAvailable: true, status: "error", models: [model] },
        { enabled: true, isAvailable: true, status: "ready", models: [] },
      ]),
    ).toBe(false);
  });
});
