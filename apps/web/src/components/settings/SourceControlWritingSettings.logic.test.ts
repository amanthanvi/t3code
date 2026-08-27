import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettingsToSnapshots,
  NO_PROVIDER_MODEL_SELECTION,
} from "../../providerInstances";
import {
  resolveActiveSourceControlWriterSelection,
  resolveSourceControlWriterToggleSelection,
} from "./SourceControlWritingSettings.logic";

describe("resolveSourceControlWriterToggleSelection", () => {
  it("copies an available default when enabling the override", () => {
    expect(
      resolveSourceControlWriterToggleSelection(
        true,
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        true,
      ),
    ).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });

  it("does not persist the local no-provider sentinel", () => {
    expect(
      resolveSourceControlWriterToggleSelection(true, NO_PROVIDER_MODEL_SELECTION, false),
    ).toBe(undefined);
  });

  it("clears the override when disabling it", () => {
    expect(
      resolveSourceControlWriterToggleSelection(false, NO_PROVIDER_MODEL_SELECTION, false),
    ).toBeNull();
  });
});

describe("resolveActiveSourceControlWriterSelection", () => {
  it("keeps a valid dedicated selection by exact identity", () => {
    const dedicatedSelection = {
      instanceId: ProviderInstanceId.make("dedicated_writer"),
      model: "anthropic/dedicated-model",
    };
    const defaultSelection = {
      instanceId: ProviderInstanceId.make("general_writer"),
      model: "openai/general-model",
    };

    expect(
      resolveActiveSourceControlWriterSelection(
        dedicatedSelection,
        dedicatedSelection,
        defaultSelection,
      ),
    ).toBe(dedicatedSelection);
  });

  it("uses the live general selection when settings-only fallbacks are unavailable", () => {
    const globalInstanceId = ProviderInstanceId.make("disabled_global");
    const dedicatedInstanceId = ProviderInstanceId.make("disabled_writer");
    const missingFallbackInstanceId = ProviderInstanceId.make("missing_fallback");
    const liveInstanceId = ProviderInstanceId.make("live_writer");
    const codex = ProviderDriverKind.make("codex");
    const claude = ProviderDriverKind.make("claudeAgent");
    const cursor = ProviderDriverKind.make("cursor");
    const grok = ProviderDriverKind.make("grok");
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        codex: { ...DEFAULT_UNIFIED_SETTINGS.providers.codex, enabled: false },
        claudeAgent: { ...DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent, enabled: false },
        cursor: { ...DEFAULT_UNIFIED_SETTINGS.providers.cursor, enabled: false },
        grok: { ...DEFAULT_UNIFIED_SETTINGS.providers.grok, enabled: false },
        opencode: { ...DEFAULT_UNIFIED_SETTINGS.providers.opencode, enabled: false },
        kilo: { ...DEFAULT_UNIFIED_SETTINGS.providers.kilo, enabled: false },
      },
      providerInstances: {
        [globalInstanceId]: { driver: codex, enabled: false },
        [dedicatedInstanceId]: { driver: claude, enabled: false },
        [missingFallbackInstanceId]: { driver: cursor, enabled: true },
        [liveInstanceId]: { driver: grok, enabled: true },
      },
      textGenerationModelSelection: {
        instanceId: globalInstanceId,
        model: "openai/disabled-global",
      },
      sourceControlWriterModelSelection: {
        instanceId: dedicatedInstanceId,
        model: "anthropic/disabled-writer",
      },
    } satisfies UnifiedSettings;
    const providers = [
      {
        instanceId: liveInstanceId,
        driver: grok,
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-08-23T00:00:00.000Z",
        models: [
          {
            slug: "xai/live-model",
            name: "Live model",
            isCustom: false,
            capabilities: {},
          },
        ],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider,
    ];
    const effectiveProviders = applyProviderInstanceSettingsToSnapshots(providers, settings);
    const generalSelection = resolveAppModelSelectionState(settings, effectiveProviders);
    const sourceControlSelection = resolveSourceControlWriterModelSelection(
      settings,
      effectiveProviders,
    );

    expect(sourceControlSelection).toMatchObject({ instanceId: missingFallbackInstanceId });
    expect(sourceControlSelection).not.toBe(settings.sourceControlWriterModelSelection);
    expect(generalSelection).toMatchObject({
      instanceId: liveInstanceId,
      model: "xai/live-model",
    });
    expect(
      resolveActiveSourceControlWriterSelection(
        sourceControlSelection,
        settings.sourceControlWriterModelSelection,
        generalSelection,
      ),
    ).toBe(generalSelection);
  });
});
