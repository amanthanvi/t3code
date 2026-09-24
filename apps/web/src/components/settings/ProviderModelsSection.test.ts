import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import { groupModelsForDisplay, nextHiddenModelsForBulkToggle } from "./ProviderModelsSection";

function model(slug: string, isCustom = false): ServerProviderModel {
  return { slug, name: slug, isCustom, capabilities: null };
}

describe("groupModelsForDisplay", () => {
  it("lists favorites first, then visible models in user order, then hidden ones", () => {
    const models = [model("a"), model("b"), model("c"), model("d"), model("custom", true)];

    const display = groupModelsForDisplay(models, {
      favoriteModels: new Set(["c"]),
      hiddenModels: new Set(["a", "custom"]),
      modelOrder: ["d", "b"],
    });

    expect(display.map((entry) => entry.slug)).toEqual(["c", "d", "b", "a", "custom"]);
  });
});

describe("nextHiddenModelsForBulkToggle", () => {
  it("hides every model, including custom models", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a"])).toEqual(["a", "b", "custom"]);
  });

  it("shows every model while preserving unrelated hidden entries", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a", "b", "legacy", "custom"])).toEqual([
      "legacy",
    ]);
  });
});
