import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ClineIcon } from "./Icons";

describe("ClineIcon", () => {
  it("keeps its brand paint when a caller supplies a text color", () => {
    const markup = renderToStaticMarkup(
      <ClineIcon className="text-foreground/80" aria-label="Cline" />,
    );

    expect(markup).toContain("fill-[#0F0F0F]");
    expect(markup).toContain("stroke-[#0F0F0F]");
    expect(markup).toContain("text-foreground/80");
    expect(markup).not.toContain("currentColor");
  });
});
