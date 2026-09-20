import {
  isEnvironmentCuratedIconId,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
} from "@t3tools/contracts";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

// Every SF name here is already a key of the Android fallback map, so a new
// id costs Metro nothing; only iOS needs a look to confirm the glyph exists.
const SYMBOL_BY_ID: Record<EnvironmentCuratedIconId, AppSymbolName> = {
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
};

export const ENVIRONMENT_ICON_LABELS: Record<EnvironmentCuratedIconId, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
  terminal: "Dev box",
  database: "Database",
  container: "Container",
  globe: "Edge",
  home: "Home server",
  gpu: "GPU box",
  network: "Network",
};

/**
 * The glyph an environment wears in lists; SF Symbols on iOS, Tabler on
 * Android. A name this build cannot draw (picked on a newer client) gets the
 * generic server so the row still reads as a machine.
 */
export function EnvironmentMachineSymbol(props: {
  readonly icon: EnvironmentIcon;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const id =
    props.icon.kind === "icon" && isEnvironmentCuratedIconId(props.icon.name)
      ? props.icon.name
      : "server";
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
