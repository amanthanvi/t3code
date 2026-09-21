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
      // A joiner binds to the character before it, so the one after it stays
      // available as the second tile instead of being dropped.
      expect(firstGrapheme("A\u200dB")).toBe("A\u200d");
      expect(firstGrapheme("A\u200cB")).toBe("A\u200c");
      // Segmenter keeps this conjunct whole. Counting code points cannot, and
      // this asserts the documented limit rather than a build-dependent answer.
      expect(firstGrapheme("क्ष")).toBe("क्");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
