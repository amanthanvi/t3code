import { describe, expect, it, vi } from "vite-plus/test";

import { firstGrapheme } from "./grapheme";

describe("firstGrapheme", () => {
  it("keeps a base character together with its combining marks", () => {
    expect(firstGrapheme("e\u0301x")).toBe("e\u0301");
    expect(firstGrapheme("K8")).toBe("K");
    expect(firstGrapheme("7")).toBe("7");
  });

  it("does not need Intl.Segmenter", () => {
    // Intl's members are non-enumerable, so a spread copy would drop every
    // other constructor; shadow only Segmenter through the prototype chain.
    vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
    try {
      expect(firstGrapheme("e\u0301x")).toBe("e\u0301");
      expect(firstGrapheme("क्ष")).toBe("क्");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
