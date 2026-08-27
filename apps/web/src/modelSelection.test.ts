import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "@t3tools/shared/model";
import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
  resolvePlanAgentHealPatch,
  withoutPlanAgentSelection,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
  supportsTextGeneration?: boolean;
  hasAuthoritativeModelCatalog?: boolean;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    ...(input.hasAuthoritativeModelCatalog === undefined
      ? {}
      : { hasAuthoritativeModelCatalog: input.hasAuthoritativeModelCatalog }),
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("instance-scoped model selection", () => {
  it("preserves server-provided legacy model metadata", () => {
    const baseProvider = provider({
      instanceId: "claudeAgent",
      models: ["claude-opus-4-8"],
    });
    const providers = [
      {
        ...baseProvider,
        models: [{ ...baseProvider.models[0]!, isLegacy: true }],
      },
    ];
    const stock = deriveProviderInstanceEntries(providers)[0]!;

    expect(getAppModelOptionsForInstance(settingsWithProviderInstances(), stock)[0]?.isLegacy).toBe(
      true,
    );
  });

  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug against the selected custom instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: ["claude-opus-4-8"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("claude_openrouter")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { customModels: ["opus"] },
        },
      },
    };
    const openrouter = deriveProviderInstanceEntries(providers)[0]!;

    expect(
      getAppModelOptionsForInstance(settings, openrouter).map((option) => option.slug),
    ).toEqual(["claude-opus-4-8", "opus"]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settings,
        providers,
        "opus",
      ),
    ).toBe("opus");
  });

  it("includes Grok custom models from the selected provider instance", () => {
    const providers = [provider({ provider: ProviderDriverKind.make("grok"), instanceId: "grok" })];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("grok")]: {
          driver: ProviderDriverKind.make("grok"),
          config: { customModels: ["grok-test-custom-model"] },
        },
      },
    };
    const grok = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "grok",
    )!;

    expect(getAppModelOptionsForInstance(settings, grok).map((option) => option.slug)).toContain(
      "grok-test-custom-model",
    );
  });

  it("ignores persisted Kilo custom models outside the authoritative command catalog", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("kilo"),
        instanceId: "kilo",
        models: ["kilo/live"],
        hasAuthoritativeModelCatalog: true,
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerInstances: {
        ...settingsWithProviderInstances().providerInstances,
        [ProviderInstanceId.make("kilo")]: {
          driver: ProviderDriverKind.make("kilo"),
          config: { customModels: ["kilo/stale"] },
        },
      },
    };
    const kilo = deriveProviderInstanceEntries(providers)[0]!;

    expect(getAppModelOptionsForInstance(settings, kilo).map((option) => option.slug)).toEqual([
      "kilo/live",
    ]);
    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("kilo"),
        settings,
        providers,
        "kilo/stale",
      ),
    ).toBe("kilo/live");
  });

  it("does not inject an unknown selected slug into the stock instance list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("preserves custom provider instances in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });

  it("heals Kilo background selection to a safe custom provider instance", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("kilo"),
        instanceId: "kilo",
        models: ["__t3_provider_default__", "kilo/openrouter/free"],
        supportsTextGeneration: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("kilo"),
        "__t3_provider_default__",
      ),
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "claude-sonnet-4-6",
    });
  });

  it("preserves the stored selection while provider snapshots are still loading", () => {
    const selection = createModelSelection(
      ProviderInstanceId.make("claude_openrouter"),
      "openai/gpt-5.5",
    );
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: selection,
    };

    expect(resolveAppModelSelectionState(settings, undefined)).toBe(selection);
  });

  it("returns the no-provider sentinel for an authoritative empty snapshot", () => {
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("claude_openrouter"),
        "openai/gpt-5.5",
      ),
    };

    expect(resolveAppModelSelectionState(settings, [])).toEqual({
      instanceId: ProviderInstanceId.make("t3code_no_provider"),
      model: "",
    });
  });

  it("returns the no-provider sentinel when only Kilo can run interactive prompts", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("kilo"),
        instanceId: "kilo",
        models: ["__t3_provider_default__", "kilo/openrouter/free"],
        supportsTextGeneration: false,
      }),
    ];
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("kilo"),
        "__t3_provider_default__",
      ),
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("t3code_no_provider"),
      model: "",
    });
  });
});

describe("withoutPlanAgentSelection", () => {
  const instance = ProviderInstanceId.make("opencode");
  const model = "opencode/gpt-5.4";

  it("drops a stored plan agent option", () => {
    const selection = createModelSelection(instance, model, [
      { id: "variant", value: "high" },
      { id: "agent", value: "plan" },
    ]);
    expect(withoutPlanAgentSelection(selection)).toEqual(
      createModelSelection(instance, model, [{ id: "variant", value: "high" }]),
    );
  });

  it("keeps non-plan agent options", () => {
    const selection = createModelSelection(instance, model, [{ id: "agent", value: "build" }]);
    expect(withoutPlanAgentSelection(selection)).toBe(selection);
  });

  it("omits options entirely when plan was the only stored option", () => {
    const selection = createModelSelection(instance, model, [{ id: "agent", value: "plan" }]);
    expect(withoutPlanAgentSelection(selection)).toEqual({ instanceId: instance, model });
  });

  it("returns null and undefined selections unchanged", () => {
    expect(withoutPlanAgentSelection(null)).toBeNull();
    expect(withoutPlanAgentSelection(undefined)).toBeUndefined();
  });
});

describe("resolvePlanAgentHealPatch", () => {
  const instance = ProviderInstanceId.make("opencode");
  const model = "opencode/gpt-5.4";
  const healed = createModelSelection(instance, model, [{ id: "variant", value: "high" }]);
  const storedPlan = createModelSelection(instance, model, [
    { id: "variant", value: "high" },
    { id: "agent", value: "plan" },
  ]);
  const nullPatch = {
    planModeEnabled: true,
    textGenerationModelSelection: storedPlan,
    sourceControlWriterModelSelection: null,
  };

  it("returns null when plan mode is on", () => {
    expect(resolvePlanAgentHealPatch(nullPatch)).toBeNull();
  });

  it("returns null when nothing needs healing", () => {
    expect(
      resolvePlanAgentHealPatch({
        planModeEnabled: false,
        textGenerationModelSelection: healed,
        sourceControlWriterModelSelection: null,
      }),
    ).toBeNull();
  });

  it("patches the stored text generation selection to drop the plan agent", () => {
    expect(
      resolvePlanAgentHealPatch({
        planModeEnabled: false,
        textGenerationModelSelection: storedPlan,
        sourceControlWriterModelSelection: null,
      }),
    ).toEqual({ textGenerationModelSelection: healed });
  });

  it("patches a stored source control writer selection that uses the plan agent", () => {
    expect(
      resolvePlanAgentHealPatch({
        planModeEnabled: false,
        textGenerationModelSelection: healed,
        sourceControlWriterModelSelection: storedPlan,
      }),
    ).toEqual({ sourceControlWriterModelSelection: healed });
  });
});
