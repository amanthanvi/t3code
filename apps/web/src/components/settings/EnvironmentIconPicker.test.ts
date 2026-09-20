import { environmentIconForMachineKind, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentIconChoiceLock,
  resolveEnvironmentIconPickerLock,
  resolveEnvironmentIconWrite,
} from "./EnvironmentIconPicker";

const config = (environmentIcon: boolean | undefined, environmentIconOverride?: boolean) =>
  ({
    environment: {
      capabilities: {
        ...(environmentIcon === undefined ? {} : { environmentIcon }),
        ...(environmentIconOverride === undefined ? {} : { environmentIconOverride }),
      },
    },
  }) as unknown as ServerConfig;

describe("resolveEnvironmentIconPickerLock", () => {
  it("locks until the environment is connected", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: null, operateAccess: "granted" }),
    ).toMatch(/Connect/);
  });

  it("locks on servers that predate the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentIconPickerLock({
        serverConfig: config(undefined),
        operateAccess: "denied",
      }),
    ).toMatch(/too old/);
  });

  it("locks when the session cannot operate the environment", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "denied" }),
    ).toMatch(/cannot change/);
  });

  it("stays open while access is still resolving so a slow session does not flicker", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "pending" }),
    ).toBeNull();
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "granted" }),
    ).toBeNull();
  });
});

describe("resolveEnvironmentIconWrite", () => {
  it("clears the override when the pick matches detection", () => {
    expect(resolveEnvironmentIconWrite({ next: "laptop", detected: "laptop" })).toBeNull();
  });

  it("writes a machine kind as its shared reference", () => {
    expect(resolveEnvironmentIconWrite({ next: "laptop", detected: "server" })).toBe(
      environmentIconForMachineKind("laptop"),
    );
  });

  it("writes a role as a named icon", () => {
    expect(resolveEnvironmentIconWrite({ next: "database", detected: "server" })).toEqual({
      kind: "icon",
      name: "database",
    });
  });
});

describe("resolveEnvironmentIconChoiceLock", () => {
  it("never locks a machine kind, which every server stores as a string", () => {
    expect(
      resolveEnvironmentIconChoiceLock({ serverConfig: config(true), id: "laptop" }),
    ).toBeNull();
    expect(resolveEnvironmentIconChoiceLock({ serverConfig: null, id: "laptop" })).toBeNull();
  });

  it("locks a role until the server stores the object form", () => {
    expect(
      resolveEnvironmentIconChoiceLock({ serverConfig: config(true), id: "database" }),
    ).toMatch(/Update/);
    expect(
      resolveEnvironmentIconChoiceLock({ serverConfig: config(true, true), id: "database" }),
    ).toBeNull();
  });
});
