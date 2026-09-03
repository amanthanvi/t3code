import { expect, it } from "vite-plus/test";

import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "./threadTitles.ts";

it("only replaces known auto-generated thread titles", () => {
  expect(canReplaceThreadTitle(DEFAULT_THREAD_TITLE)).toBe(true);
  expect(canReplaceThreadTitle("Fork: Parent thread")).toBe(false);
  expect(canReplaceThreadTitle("Side chat: Parent thread")).toBe(false);
  expect(canReplaceThreadTitle("A deliberate title")).toBe(false);
});
