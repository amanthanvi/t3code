import {
  ENVIRONMENT_LUCIDE_ICON_IDS,
  environmentIconForMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentIconChoiceLock,
  resolveEnvironmentIconDialogWrite,
  resolveEnvironmentIconPickerLock,
} from "./EnvironmentIconPicker.logic";
import { filterEnvironmentLucideIconIds } from "./EnvironmentIconPickerDialog";

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

describe("resolveEnvironmentIconChoiceLock", () => {
  it("never locks a machine kind, which every server stores as a string", () => {
    expect(
      resolveEnvironmentIconChoiceLock({ serverConfig: config(true), id: "laptop" }),
    ).toBeNull();
    expect(resolveEnvironmentIconChoiceLock({ serverConfig: null, id: "laptop" })).toBeNull();
  });

  it("locks a detected-only kind like a role, since it has no string form", () => {
    expect(
      resolveEnvironmentIconChoiceLock({ serverConfig: config(true), id: "container" }),
    ).toMatch(/Update/);
    expect(
      resolveEnvironmentIconChoiceLock({ serverConfig: config(true, true), id: "container" }),
    ).toBeNull();
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

describe("resolveEnvironmentIconDialogWrite", () => {
  const base = {
    iconId: "laptop",
    color: null,
    emoji: "🚀",
    monogram: "K8",
    detected: "server",
  } as const;

  it("clears the override when a plain pick matches detection", () => {
    expect(resolveEnvironmentIconDialogWrite({ ...base, mode: "icon", iconId: "server" })).toEqual({
      kind: "write",
      icon: null,
    });
  });

  it("writes a machine kind as its shared reference and a role as a named icon", () => {
    const plain = resolveEnvironmentIconDialogWrite({ ...base, mode: "icon" });
    expect(plain.kind === "write" && plain.icon).toBe(environmentIconForMachineKind("laptop"));
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "icon", iconId: "database" }),
    ).toEqual({ kind: "write", icon: { kind: "icon", name: "database" } });
  });

  it("prefers a pick from the shared Lucide list over the curated grid", () => {
    expect(resolveEnvironmentIconDialogWrite({ ...base, mode: "icon", lucideId: "cpu" })).toEqual({
      kind: "write",
      icon: { kind: "icon", name: "cpu" },
    });
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "icon", lucideId: "cpu", color: "sky" }),
    ).toEqual({ kind: "write", icon: { kind: "icon", name: "cpu", color: "sky" } });
  });

  it("keeps a colored pick of the detected kind, since the color is the point", () => {
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "icon", iconId: "server", color: "red" }),
    ).toEqual({ kind: "write", icon: { kind: "icon", name: "server", color: "red" } });
  });

  it("accepts exactly one emoji and nothing else", () => {
    expect(resolveEnvironmentIconDialogWrite({ ...base, mode: "emoji" })).toEqual({
      kind: "write",
      icon: { kind: "emoji", emoji: "🚀" },
    });
    expect(resolveEnvironmentIconDialogWrite({ ...base, mode: "emoji", emoji: "x" }).kind).toBe(
      "invalid",
    );
  });

  it("normalizes a monogram and holds it to two characters", () => {
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "monogram", monogram: " k8 " }),
    ).toEqual({ kind: "write", icon: { kind: "monogram", text: "K8" } });
    expect(
      resolveEnvironmentIconDialogWrite({
        ...base,
        mode: "monogram",
        monogram: "e\u0301x",
        color: "teal",
      }),
    ).toEqual({ kind: "write", icon: { kind: "monogram", text: "ÉX", color: "teal" } });
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "monogram", monogram: "ABC" }).kind,
    ).toBe("invalid");
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "monogram", monogram: "" }).kind,
    ).toBe("invalid");
  });
});

describe("resolveEnvironmentIconDialogWrite image mode", () => {
  const base = {
    iconId: "laptop",
    color: null,
    emoji: "🚀",
    monogram: "K8",
    detected: "server",
  } as const;

  it("writes only a data URL the contract accepts", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "image", imageDataUrl: png }),
    ).toEqual({ kind: "write", icon: { kind: "image", dataUrl: png } });
    expect(
      resolveEnvironmentIconDialogWrite({ ...base, mode: "image", imageDataUrl: null }).kind,
    ).toBe("invalid");
    // An SVG can script, so the encoder never produces one and the write refuses it.
    expect(
      resolveEnvironmentIconDialogWrite({
        ...base,
        mode: "image",
        imageDataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
      }).kind,
    ).toBe("invalid");
  });
});

describe("filterEnvironmentLucideIconIds", () => {
  it("matches every word of the query against the id and keeps list order", () => {
    expect(filterEnvironmentLucideIconIds("")).toBe(ENVIRONMENT_LUCIDE_ICON_IDS);
    expect(filterEnvironmentLucideIconIds("server")).toEqual([
      "server-cog",
      "server-crash",
      "server-off",
    ]);
    expect(filterEnvironmentLucideIconIds("  Cloud  down ")).toEqual(["cloud-download"]);
    expect(filterEnvironmentLucideIconIds("nothing-like-this")).toEqual([]);
  });
});
