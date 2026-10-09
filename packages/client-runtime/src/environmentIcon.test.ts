import { environmentIconForMachineKind, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentIconLock,
  resolveEnvironmentIconPick,
  resolveEnvironmentRichIconLock,
} from "./environmentIcon.ts";

const config = (environmentIcon: boolean | undefined, environmentIconOverride?: boolean) =>
  ({
    environment: {
      capabilities: {
        ...(environmentIcon === undefined ? {} : { environmentIcon }),
        ...(environmentIconOverride === undefined ? {} : { environmentIconOverride }),
      },
    },
  }) as unknown as ServerConfig;

describe("resolveEnvironmentIconLock", () => {
  const open = { connected: true, canWriteSettings: true } as const;

  it("locks until the environment is connected, even with a cached config", () => {
    expect(resolveEnvironmentIconLock({ ...open, serverConfig: null })).toMatch(/Connect/);
    expect(
      resolveEnvironmentIconLock({ ...open, serverConfig: config(true), connected: false }),
    ).toMatch(/Connect/);
  });

  it("locks on servers that predate the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentIconLock({
        serverConfig: config(undefined),
        connected: true,
        canWriteSettings: false,
      }),
    ).toMatch(/too old/);
  });

  it("locks without a settings grant", () => {
    expect(
      resolveEnvironmentIconLock({ ...open, serverConfig: config(true), canWriteSettings: false }),
    ).toMatch(/cannot change/);
    expect(resolveEnvironmentIconLock({ ...open, serverConfig: config(true) })).toBeNull();
  });
});

describe("resolveEnvironmentRichIconLock", () => {
  it("locks the object form until the server advertises it", () => {
    expect(resolveEnvironmentRichIconLock(null)).toMatch(/Update/);
    expect(resolveEnvironmentRichIconLock(config(true))).toMatch(/Update/);
    expect(resolveEnvironmentRichIconLock(config(true, true))).toBeNull();
  });
});

describe("resolveEnvironmentIconPick", () => {
  it("clears on the detected kind, shares machine kinds, names roles", () => {
    expect(resolveEnvironmentIconPick({ next: "laptop", detected: "laptop" })).toBeNull();
    expect(resolveEnvironmentIconPick({ next: "laptop", detected: "server" })).toBe(
      environmentIconForMachineKind("laptop"),
    );
    expect(resolveEnvironmentIconPick({ next: "database", detected: "server" })).toEqual({
      kind: "icon",
      name: "database",
    });
  });
});
