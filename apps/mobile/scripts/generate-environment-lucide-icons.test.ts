import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { renderEnvironmentLucideIconsModule } from "./generate-environment-lucide-icons.mts";

describe("generate environment Lucide icons", () => {
  it("keeps the committed module current", () => {
    const generated = NodePath.resolve(
      import.meta.dirname,
      "../src/components/environmentLucideIcons.generated.ts",
    );
    expect(
      NodeFS.existsSync(generated) ? NodeFS.readFileSync(generated, "utf8") : null,
      "Run `vp run --filter @t3tools/mobile generate:lucide-icons` and commit the output.",
    ).toBe(renderEnvironmentLucideIconsModule());
  });
});
