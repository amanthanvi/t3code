import { describe, expect, it } from "vite-plus/test";

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
});
