import { describe, expect, it } from "vite-plus/test";

import { sourceControlWriterToggleState } from "./SourceControlWritingSettings";

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
});
