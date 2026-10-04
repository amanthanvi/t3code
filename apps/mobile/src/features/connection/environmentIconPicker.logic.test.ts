import { environmentIconForMachineKind, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { listMobileEnvironmentIconChoices } from "./environmentIconPicker.logic";

const config = (environmentIcon: boolean | undefined, environmentIconOverride?: boolean) =>
  ({
    environment: {
      capabilities: {
        ...(environmentIcon === undefined ? {} : { environmentIcon }),
        ...(environmentIconOverride === undefined ? {} : { environmentIconOverride }),
      },
    },
  }) as unknown as ServerConfig;

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
