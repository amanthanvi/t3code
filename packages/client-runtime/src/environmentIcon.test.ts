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
  it("locks until the environment is connected", () => {
    expect(resolveEnvironmentIconLock({ serverConfig: null, operateAccess: "granted" })).toMatch(
      /Connect/,
    );
  });

  it("locks on servers that predate the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentIconLock({ serverConfig: config(undefined), operateAccess: "denied" }),
    ).toMatch(/too old/);
  });

  it("locks when the session cannot operate the environment", () => {
    expect(
      resolveEnvironmentIconLock({ serverConfig: config(true), operateAccess: "denied" }),
    ).toMatch(/cannot change/);
  });

  it("stays open while access is still resolving so a slow session does not flicker", () => {
    expect(
      resolveEnvironmentIconLock({ serverConfig: config(true), operateAccess: "pending" }),
    ).toBeNull();
    expect(
      resolveEnvironmentIconLock({ serverConfig: config(true), operateAccess: "granted" }),
    ).toBeNull();
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
