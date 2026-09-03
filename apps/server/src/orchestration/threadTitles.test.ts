import { expect, it } from "vite-plus/test";

import { canReplaceThreadTitle, forkThreadTitle, DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

it("only replaces known auto-generated thread titles", () => {
  expect(canReplaceThreadTitle(DEFAULT_THREAD_TITLE)).toBe(true);
  expect(canReplaceThreadTitle("Fork: Parent thread")).toBe(false);
  expect(canReplaceThreadTitle("Side chat: Parent thread")).toBe(false);
  expect(canReplaceThreadTitle("A deliberate title")).toBe(false);
});

it("numbers forks after their source like the Codex app", () => {
  expect(forkThreadTitle("Fix the parser", [])).toBe("Fix the parser (1)");
  expect(forkThreadTitle("Fix the parser", ["Fix the parser (1)"])).toBe("Fix the parser (2)");
  // Forking a fork counts from the shared base, and gaps left by renames or
  // deletions are reused.
  expect(forkThreadTitle("Fix the parser (2)", ["Fix the parser (2)"])).toBe("Fix the parser (1)");
  expect(forkThreadTitle("  ", [])).toBe("New thread (1)");
});
