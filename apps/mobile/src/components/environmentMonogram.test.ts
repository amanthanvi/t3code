import { describe, expect, it, vi } from "vite-plus/test";

import { monogramCharacters } from "./environmentMonogram";

describe("monogramCharacters", () => {
  it("shows one or two characters and never a third", () => {
    expect(monogramCharacters("K8")).toEqual(["K", "8"]);
    expect(monogramCharacters("ABC")).toEqual(["A", "B"]);
    expect(monogramCharacters("A")).toEqual(["A"]);
  });

  it("keeps a combining mark with its base", () => {
    expect(monogramCharacters("e\u0301K")).toEqual(["e\u0301", "K"]);
  });

  it("keeps both characters around a joiner without Intl.Segmenter", () => {
    // MonogramText admits ZWJ and ZWNJ. A fallback that stopped at the base
    // character split "A\u200dB" into "A" and the bare joiner, so the tile
    // drew nothing where the "B" should have been.
    vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
    try {
      expect(monogramCharacters("A\u200dB")).toEqual(["A\u200d", "B"]);
      expect(monogramCharacters("A\u200cB")).toEqual(["A\u200c", "B"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
