import { describe, expect, it } from "vite-plus/test";

import { firstGrapheme } from "./grapheme";

describe("firstGrapheme", () => {
  it("keeps a base character together with its combining marks", () => {
    expect(firstGrapheme("e\u0301x")).toBe("e\u0301");
    expect(firstGrapheme("K8")).toBe("K");
    expect(firstGrapheme("7")).toBe("7");
  });

  it("keeps a joiner with the character before it", () => {
    // MonogramText admits both joiners. Stopping at the base character would
    // leave the bare joiner as the second tile and drop the "B".
    expect(firstGrapheme("A\u200dB")).toBe("A\u200d");
    expect(firstGrapheme("A\u200cB")).toBe("A\u200c");
  });

  it("splits a conjunct that grapheme segmentation keeps whole", () => {
    // The documented limit of counting code points. isMonogramLength counts
    // the same way, so the picker refuses what two tiles cannot show.
    expect(firstGrapheme("क्ष")).toBe("क्");
  });
});
