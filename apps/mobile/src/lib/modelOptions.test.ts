import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveDispatchableModelSelection,
  resolveSelectableModelSelection,
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

  it("heals stale Kilo selections and does not synthesize a ghost model row", () => {
    const config = {
      providers: [
        {
          instanceId: "kilo",
          driver: "kilo",
          displayName: "Kilo Code",
          enabled: true,
          installed: true,
          hasAuthoritativeModelCatalog: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "kilo/live",
              name: "Kilo Live",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;
    const stale = {
      instanceId: ProviderInstanceId.make("kilo"),
      model: "kilo/stale",
      options: [{ id: "reasoning", value: "high" }],
    };

    expect(resolveSelectableModelSelection(config, stale)).toEqual({
      instanceId: "kilo",
      model: "kilo/live",
    });
    expect(buildModelOptions(config, stale).map((option) => option.key)).toEqual([
      "kilo:kilo/live",
    ]);
  });

  it("preserves Kilo routing while blocking dispatch until the catalog is authoritative", () => {
    const config = {
      providers: [
        {
          instanceId: "kilo",
          driver: "kilo",
          enabled: true,
          installed: true,
          status: "warning",
          hasAuthoritativeModelCatalog: true,
          auth: { status: "authenticated" },
          models: [],
        },
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-default",
              name: "GPT Default",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;
    const stored = { instanceId: ProviderInstanceId.make("kilo"), model: "kilo/offline" };

    expect(resolveSelectableModelSelection(config, stored)).toBe(stored);
    expect(resolveDefaultableModelSelection(config, stored)).toBe(stored);
    expect(resolveDispatchableModelSelection(config, stored)).toBeNull();
    expect(buildModelOptions(config, stored).map((option) => option.key)).toEqual([
      "codex:gpt-default",
      "kilo:kilo/offline",
    ]);

    const reconnected = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.driver === "kilo"
          ? {
              ...provider,
              status: "ready",
              models: [
                {
                  slug: "kilo/live",
                  name: "Kilo Live",
                  isCustom: false,
                  isDefault: true,
                  capabilities: null,
                },
              ],
            }
          : provider,
      ),
    } as unknown as ServerConfig;
    expect(resolveDispatchableModelSelection(reconnected, stored)).toEqual({
      instanceId: "kilo",
      model: "kilo/live",
    });
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
