import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canUseProviderInteractionModeShortcut,
  getUnsupportedProviderAttachmentReason,
  getProviderSupportedRuntimeModes,
  getUnsupportedProviderModeReason,
} from "./providerModels";

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("cline"),
  driver: ProviderDriverKind.make("cline"),
  displayName: "Cline",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("provider mode capabilities", () => {
  it("keeps legacy providers compatible when runtime modes are absent", () => {
    expect(getProviderSupportedRuntimeModes(provider())).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });

  it("requires an explicit safe mode change for restricted providers", () => {
    const cline = provider({
      showInteractionModeToggle: false,
      supportedRuntimeModes: ["full-access"],
    });

    expect(
      getUnsupportedProviderModeReason({
        provider: cline,
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
    ).toContain("Choose Full access");
    expect(
      getUnsupportedProviderModeReason({
        provider: cline,
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    ).toContain("Choose Build");
    expect(
      getUnsupportedProviderModeReason({
        provider: cline,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBeNull();
  });

  it("blocks entering Plan by shortcut but preserves the Build escape", () => {
    expect(
      canUseProviderInteractionModeShortcut({
        planModeUiEnabled: true,
        showInteractionModeToggle: false,
        interactionMode: "default",
      }),
    ).toBe(false);
    expect(
      canUseProviderInteractionModeShortcut({
        planModeUiEnabled: true,
        showInteractionModeToggle: false,
        interactionMode: "plan",
      }),
    ).toBe(true);
  });

  it("rejects carried images only when the provider explicitly disallows them", () => {
    expect(
      getUnsupportedProviderAttachmentReason(provider({ supportsImageAttachments: false }), 1),
    ).toContain("Remove the images");
    expect(getUnsupportedProviderAttachmentReason(provider(), 1)).toBeNull();
    expect(
      getUnsupportedProviderAttachmentReason(provider({ supportsImageAttachments: false }), 0),
    ).toBeNull();
  });
});
