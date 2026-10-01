import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import type { ModelManifestData } from "./ModelManifest.ts";
import {
  applyClaudeConfiguredDefault,
  extendClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "./ClaudeModelCatalog.ts";

/**
 * Test policy: adding or changing a real Claude model in model-manifest.json
 * must not add or update tests here. These synthetic fixtures cover resolver
 * behavior once. Add a test only when Claude adapter semantics change, such
 * as introducing a new compatibility rule or dispatch mapping type.
 */

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "standard", label: "200k" },
                  { id: "large", label: "Large", isDefault: true },
                ],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

describe("Claude model catalog", () => {
  it("maps a qualified instance default to the visible native model", () => {
    const catalog = resolveClaudeModelCatalog(manifest());
    const configured = applyClaudeConfiguredDefault(
      catalog,
      "claude/claude-synthetic-next",
      "claude/",
    );
    assert.deepStrictEqual(
      configured.models.filter(({ model }) => model.isDefault).map(({ model }) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.strictEqual(applyClaudeConfiguredDefault(catalog, "claude/missing", "claude/"), catalog);
  });

  it("adds only new qualified gateway models without guessing context capabilities", () => {
    const catalog = extendClaudeModelCatalog(
      resolveClaudeModelCatalog(manifest()),
      [
        { value: "sonnet", resolvedModel: "claude/claude-sonnet-5-5", displayName: "Sonnet alias" },
        { value: "claude/claude-synthetic-next", displayName: "Duplicate built-in" },
        { value: "claude/claude-legacy", displayName: "Saved compatibility route" },
        { value: "openrouter/claude-sonnet-5-5", displayName: "Other provider" },
        {
          value: "claude/claude-sonnet-5-5",
          displayName: "Claude Sonnet 5.5",
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        { value: "claude/claude-sonnet-5-5", displayName: "Duplicate route" },
      ],
      ["claude/claude-legacy"],
      "claude/",
    );
    assert.deepStrictEqual(
      catalog.models.map(({ model }) => model.slug),
      ["claude-synthetic-next", "claude/claude-sonnet-5-5"],
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(
        catalog,
        {
          instanceId: ProviderInstanceId.make("claude-cpamc"),
          model: "claude/claude-sonnet-5-5",
          options: [{ id: "effort", value: "xhigh" }],
        },
        "claude/",
      ),
      "claude/claude-sonnet-5-5",
    );
    assert.deepStrictEqual(
      getClaudeCatalogModelCapabilities(catalog, "claude/claude-sonnet-5-5").optionDescriptors?.map(
        ({ id }) => id,
      ),
      ["effort"],
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude/claude-sonnet-5-5", "xhigh"),
      "xhigh",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude/claude-sonnet-5-5", undefined),
      undefined,
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = resolveClaudeModelCatalog(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = resolveClaudeModelCatalog(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("qualifies built-in Opus IDs before context suffixes without changing custom IDs", () => {
    const base = manifest();
    const catalog = scopeClaudeModelCatalog(
      resolveClaudeModelCatalog({
        ...base,
        providers: {
          ...base.providers,
          claudeAgent: {
            ...base.providers!.claudeAgent!,
            models: [
              {
                slug: "claude-opus-5-5",
                name: "Claude Opus 5.5",
                aliases: ["opus"],
                status: "current",
                profile: "synthetic",
              },
            ],
          },
        },
      }),
      ["claude/claude-opus-5-5"],
    );
    const selection = (model: string, options?: Array<{ id: string; value: string }>) => ({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model,
      ...(options ? { options } : {}),
    });
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, selection("opus"), "claude/"),
      "claude/claude-opus-5-5[large]",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(
        catalog,
        selection("claude-opus-5-5", [{ id: "contextWindow", value: "standard" }]),
        "claude/",
      ),
      "claude/claude-opus-5-5",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, selection("opus")),
      "claude-opus-5-5[large]",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, selection("claude/claude-opus-5-5"), "claude/"),
      "claude/claude-opus-5-5",
    );
  });

  it("rejects malformed adapter mappings", () => {
    const base = manifest();
    const malformed: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          profiles: {
            ...base.providers!.claudeAgent!.profiles,
            synthetic: {
              ...base.providers!.claudeAgent!.profiles.synthetic!,
              adapter: { claudeCode: { effortMap: { extreme: 123 } } },
            },
          },
        },
      },
    };
    assert.isFalse(hasValidClaudeManifestAdapters(malformed));
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(resolveClaudeModelCatalog(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
              ],
            },
          ],
        },
      },
    ]);

    // The bare custom slug shadows the built-in alias, so it no longer resolves to it.
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"), undefined);

    // The entry with descriptors resolves user-defined effort ids and passes
    // them through untouched (no effortMap, no model suffix).
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });
});
