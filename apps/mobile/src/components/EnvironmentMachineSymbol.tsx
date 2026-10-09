import {
  ENVIRONMENT_ICON_LABELS,
  isEnvironmentCuratedIconId,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
} from "@t3tools/contracts";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

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

/** The symbol name for places that only take one, such as native menu items. */
export function environmentMachineSymbolName(icon: EnvironmentIcon) {
  return SYMBOL_BY_ID[symbolId(icon)];
}

/** The glyph an environment wears in lists; SF Symbols on iOS, Tabler on Android. */
export function EnvironmentMachineSymbol(props: {
  readonly icon: EnvironmentIcon;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const id = symbolId(props.icon);
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_ICON_LABELS[id]}
      name={SYMBOL_BY_ID[id]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}
