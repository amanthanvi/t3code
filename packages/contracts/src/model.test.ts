import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_PROVIDER_DRIVER_CAPABILITIES, getProviderDriverCapabilities } from "./model.ts";
import { ALL_RUNTIME_MODES, RuntimeMode } from "./orchestration.ts";

describe("getProviderDriverCapabilities", () => {
  it("withholds text generation, MCP, and custom models for Cline", () => {
    expect(getProviderDriverCapabilities("cline")).toEqual({
      supportsTextGeneration: false,
      consumesMcpServers: false,
      supportsCustomModels: false,
      modelCatalogIsAuthoritative: true,
    });
  });

  it("grants every capability to other built-in drivers", () => {
    for (const driver of ["codex", "claudeAgent", "cursor", "grok", "opencode"]) {
      expect(getProviderDriverCapabilities(driver)).toBe(DEFAULT_PROVIDER_DRIVER_CAPABILITIES);
    }
  });

  it("grants every capability to unknown fork drivers and malformed slugs", () => {
    expect(getProviderDriverCapabilities("some-fork_driver")).toBe(
      DEFAULT_PROVIDER_DRIVER_CAPABILITIES,
    );
    expect(getProviderDriverCapabilities("")).toBe(DEFAULT_PROVIDER_DRIVER_CAPABILITIES);
    expect(getProviderDriverCapabilities(null)).toBe(DEFAULT_PROVIDER_DRIVER_CAPABILITIES);
    expect(getProviderDriverCapabilities(undefined)).toBe(DEFAULT_PROVIDER_DRIVER_CAPABILITIES);
  });
});

describe("ALL_RUNTIME_MODES", () => {
  it("stays in sync with the RuntimeMode schema", () => {
    expect(ALL_RUNTIME_MODES).toEqual(RuntimeMode.literals);
    expect(ALL_RUNTIME_MODES).toContain("full-access");
  });
});
