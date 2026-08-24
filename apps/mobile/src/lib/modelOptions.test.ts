import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelOptions,
  getUnsupportedProviderAttachmentReason,
  getUnsupportedProviderModeReason,
  getUnavailableProviderModelReason,
  getProviderSendBlockReason,
  groupByProvider,
  providerSupportsImageAttachments,
  resolveDefaultableModelSelection,
  resolveSelectableModelSelection,
  shouldShowProviderInteractionModeToggle,
} from "./modelOptions";

describe("mobile model options", () => {
  it("groups models by provider and flags legacy entries", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(groupByProvider(buildModelOptions(config, null))).toMatchObject([
      {
        providerKey: "codex",
        providerLabel: "Codex",
        models: [
          { key: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol", isLegacy: false },
          { key: "codex:gpt-5.4", label: "GPT-5.4", isLegacy: true },
        ],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });

  it("rejects stored selections whose provider is not usable", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: false,
          installed: true,
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;

    const usable = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    };
    const disabled = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const removed = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.6-sol",
    };

    expect(resolveSelectableModelSelection(config, usable)).toBe(usable);
    expect(resolveSelectableModelSelection(config, disabled)).toBeNull();
    expect(resolveSelectableModelSelection(config, removed)).toBeNull();
    // No config (environment offline) — nothing to validate against.
    expect(resolveSelectableModelSelection(null, disabled)).toBe(disabled);
  });

  it("preserves but blocks Cline selections missing from the online catalog", () => {
    const config = {
      providers: [
        {
          instanceId: "cline",
          driver: "cline",
          enabled: true,
          installed: true,
          status: "error",
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;
    const stale = {
      instanceId: ProviderInstanceId.make("cline"),
      model: "composer-2",
    };

    expect(resolveSelectableModelSelection(config, stale)).toBe(stale);
    expect(getUnavailableProviderModelReason({ config, selection: stale })).toContain(
      "Choose another model",
    );
    expect(buildModelOptions(config, stale)).toEqual([]);
    const changedCatalog = {
      ...config,
      providers: [
        {
          ...config.providers[0]!,
          status: "ready",
          models: [
            {
              slug: "current-account-model",
              name: "Current account model",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;
    expect(resolveSelectableModelSelection(changedCatalog, stale)).toBe(stale);
    expect(
      getUnavailableProviderModelReason({ config: changedCatalog, selection: stale }),
    ).toContain("Choose another model");
    expect(
      buildModelOptions(changedCatalog, stale).map((option) => option.selection.model),
    ).toEqual(["current-account-model"]);
    // Offline config cannot be validated, so the existing draft remains
    // available until a server snapshot arrives.
    expect(resolveSelectableModelSelection(null, stale)).toBe(stale);
    expect(buildModelOptions(null, stale)).toHaveLength(1);
  });

  it("preserves Cline routing while its model catalog is still checking", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("cline"),
      model: "last-known-cline-model",
    };
    const config = {
      providers: [
        {
          instanceId: "cline",
          driver: "cline",
          displayName: "Cline",
          enabled: true,
          installed: true,
          status: "warning",
          auth: { status: "unknown" },
          showInteractionModeToggle: false,
          supportsImageAttachments: false,
          models: [],
        },
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(resolveSelectableModelSelection(config, selection)).toEqual(selection);
    expect(
      buildModelOptions(config, selection).some((option) => option.providerKey === "cline"),
    ).toBe(false);
    expect(getUnavailableProviderModelReason({ config, selection })).toContain("still checking");
    expect(providerSupportsImageAttachments({ config, selection })).toBe(false);
    expect(
      getProviderSendBlockReason({
        config,
        selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        attachmentCount: 1,
      }),
    ).not.toBeNull();
    expect(
      shouldShowProviderInteractionModeToggle({
        config,
        selection,
        interactionMode: "default",
      }),
    ).toBe(false);
    expect(
      shouldShowProviderInteractionModeToggle({
        config,
        selection,
        interactionMode: "plan",
      }),
    ).toBe(true);
  });

  it("preserves carried Cline modes but blocks them until the user chooses supported modes", () => {
    const config = {
      providers: [
        {
          instanceId: "cline",
          driver: "cline",
          displayName: "Cline",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          supportedRuntimeModes: ["full-access"],
          showInteractionModeToggle: false,
          supportsImageAttachments: false,
          models: [
            {
              slug: "current-account-model",
              name: "Current account model",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;
    const selection = {
      instanceId: ProviderInstanceId.make("cline"),
      model: "current-account-model",
    };

    expect(
      getUnsupportedProviderModeReason({
        config,
        selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
    ).toContain("Choose Full access");
    expect(
      getUnsupportedProviderModeReason({
        config,
        selection,
        runtimeMode: "full-access",
        interactionMode: "plan",
      }),
    ).toContain("Choose Build");
    expect(
      getUnsupportedProviderModeReason({
        config,
        selection,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBeNull();
    expect(groupByProvider(buildModelOptions(config, selection))[0]).toMatchObject({
      supportedRuntimeModes: ["full-access"],
      showInteractionModeToggle: false,
      supportsImageAttachments: false,
    });
    expect(
      getUnsupportedProviderAttachmentReason({ config, selection, attachmentCount: 1 }),
    ).toContain("Remove the images");
    expect(
      getUnsupportedProviderAttachmentReason({ config, selection, attachmentCount: 0 }),
    ).toBeNull();
    expect(
      getProviderSendBlockReason({
        config,
        selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        attachmentCount: 1,
      }),
    ).toContain("Remove the images");
  });

  it("keeps legacy models out of implicit defaults", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false, capabilities: null },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const current = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const legacy = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

    expect(resolveDefaultableModelSelection(config, current)).toBe(current);
    // A legacy last-used selection falls through to the provider default.
    expect(resolveDefaultableModelSelection(config, legacy)).toBeNull();
    // Offline: nothing to validate against, selection passes through.
    expect(resolveDefaultableModelSelection(null, legacy)).toBe(legacy);
  });
});
