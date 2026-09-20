import { environmentIconForMachineKind, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  listMobileEnvironmentIconChoices,
  resolveMobileEnvironmentIconLock,
  resolveMobileEnvironmentIconWrite,
  selectedMobileEnvironmentIconId,
} from "./environmentIconPicker.logic";

const config = (environmentIcon: boolean | undefined, environmentIconOverride?: boolean) =>
  ({
    environment: {
      capabilities: {
        ...(environmentIcon === undefined ? {} : { environmentIcon }),
        ...(environmentIconOverride === undefined ? {} : { environmentIconOverride }),
      },
    },
  }) as unknown as ServerConfig;

describe("resolveMobileEnvironmentIconLock", () => {
  it("locks until connected, then on servers that predate the setting", () => {
    expect(resolveMobileEnvironmentIconLock(null)).toMatch(/Connect/);
    expect(resolveMobileEnvironmentIconLock(config(undefined))).toMatch(/too old/);
    expect(resolveMobileEnvironmentIconLock(config(true))).toBeNull();
  });
});

describe("listMobileEnvironmentIconChoices", () => {
  it("marks detection and gates roles on the object-form capability", () => {
    const legacy = listMobileEnvironmentIconChoices({
      serverConfig: config(true),
      detected: "laptop",
    });
    expect(legacy.find((choice) => choice.id === "laptop")).toMatchObject({
      detected: true,
      enabled: true,
    });
    expect(legacy.find((choice) => choice.id === "database")).toMatchObject({
      detected: false,
      enabled: false,
    });
    // Detected later than the bare-string form, so it travels as the object.
    expect(legacy.find((choice) => choice.id === "container")?.enabled).toBe(false);

    const current = listMobileEnvironmentIconChoices({
      serverConfig: config(true, true),
      detected: "laptop",
    });
    expect(current.every((choice) => choice.enabled)).toBe(true);
    expect(current.find((choice) => choice.id === "laptop")?.icon).toBe(
      environmentIconForMachineKind("laptop"),
    );
  });
});

describe("resolveMobileEnvironmentIconWrite", () => {
  it("clears on the detected kind, shares machine kinds, names roles", () => {
    expect(resolveMobileEnvironmentIconWrite({ next: "laptop", detected: "laptop" })).toBeNull();
    expect(resolveMobileEnvironmentIconWrite({ next: "laptop", detected: "server" })).toBe(
      environmentIconForMachineKind("laptop"),
    );
    expect(resolveMobileEnvironmentIconWrite({ next: "database", detected: "server" })).toEqual({
      kind: "icon",
      name: "database",
    });
  });
});

describe("selectedMobileEnvironmentIconId", () => {
  it("selects a curated pick and nothing else", () => {
    expect(selectedMobileEnvironmentIconId({ kind: "icon", name: "gpu" })).toBe("gpu");
    expect(selectedMobileEnvironmentIconId({ kind: "icon", name: "cpu" })).toBeNull();
    expect(selectedMobileEnvironmentIconId({ kind: "emoji", emoji: "🚀" })).toBeNull();
  });
});
