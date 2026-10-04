import {
  ENVIRONMENT_ICON_LABELS,
  isEnvironmentCuratedIconId,
  isEnvironmentLucideIconId,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
} from "@t3tools/contracts";

import { projectIconColorClassNames } from "../lib/projectIcon";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { EnvironmentLucideIcon } from "./EnvironmentLucideIcon";
import { ProjectIconGlyphView } from "./ProjectFavicon";

// Every SF name here is already a key of the Android fallback map, so a new
// id adds nothing to the Metro bundle; only iOS needs a check that the glyph
// exists.
const SYMBOL_BY_ID = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
  terminal: "terminal",
  database: "internaldrive",
  container: "cube",
  globe: "globe",
  home: "house",
  gpu: "brain",
  network: "point.3.connected.trianglepath.dotted",
} as const satisfies Record<EnvironmentCuratedIconId, AppSymbolName>;

/**
 * The curated id an icon draws as. A name this build cannot draw (picked on
 * a newer client) gets the generic server so the row still reads as a
 * machine.
 */
function symbolId(icon: EnvironmentIcon): EnvironmentCuratedIconId {
  return icon.kind === "icon" && isEnvironmentCuratedIconId(icon.name) ? icon.name : "server";
}

/**
 * The symbol name for places that only take one, such as native menu items.
 * Anything other than a curated icon has no symbol, so it gets the generic
 * server there.
 */
export function environmentMachineSymbolName(icon: EnvironmentIcon) {
  return SYMBOL_BY_ID[symbolId(icon)];
}

/**
 * The glyph an environment wears in lists; SF Symbols on iOS, Tabler on
 * Android. `tintColorClassName` is the caller's resting tint; a chosen color
 * replaces it. Rows draw connection state beside the glyph, never on it, so a
 * red icon never reads as a failed one. Emoji and monograms draw as project
 * icons do.
 */
export function EnvironmentMachineSymbol(props: {
  readonly icon: EnvironmentIcon;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const { icon, size } = props;
  if (icon.kind === "emoji") {
    return <ProjectIconGlyphView glyph={icon} size={size} />;
  }
  if (icon.kind === "monogram") {
    return (
      <ProjectIconGlyphView
        glyph={{ kind: "monogram", text: icon.text, color: icon.color ?? "gray" }}
        size={size}
      />
    );
  }
  const tintColorClassName =
    icon.kind === "icon" && icon.color !== undefined
      ? projectIconColorClassNames(icon.color).tint
      : props.tintColorClassName;
  // Curated first, then the shared Lucide list; the generated module holds
  // path data for exactly those ids, so anything else is the generic server.
  if (
    icon.kind === "icon" &&
    !isEnvironmentCuratedIconId(icon.name) &&
    isEnvironmentLucideIconId(icon.name)
  ) {
    return (
      <EnvironmentLucideIcon
        id={icon.name}
        size={size}
        colorClassName={tintColorClassName}
        accessibilityLabel={icon.name.replaceAll("-", " ")}
      />
    );
  }
  const id = symbolId(icon);
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_ICON_LABELS[id]}
      name={SYMBOL_BY_ID[id]}
      size={size}
      tintColorClassName={tintColorClassName}
      type="monochrome"
    />
  );
}
