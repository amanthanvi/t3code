import {
  isEnvironmentMachineKind,
  type EnvironmentIcon,
  type EnvironmentMachineKind,
} from "@t3tools/contracts";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

export const ENVIRONMENT_MACHINE_SYMBOLS = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
} as const satisfies Record<EnvironmentMachineKind, AppSymbolName>;

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

/**
 * The machine kind an icon draws as. A name this build cannot draw (picked
 * on a newer client) gets the generic server so the row still reads as a
 * machine.
 */
function symbolKind(icon: EnvironmentIcon): EnvironmentMachineKind {
  return icon.kind === "icon" && isEnvironmentMachineKind(icon.name) ? icon.name : "server";
}

/** The symbol name for places that only take one, such as native menu items. */
export function environmentMachineSymbolName(icon: EnvironmentIcon) {
  return ENVIRONMENT_MACHINE_SYMBOLS[symbolKind(icon)];
}

/** The glyph an environment wears in lists; SF Symbols on iOS, Tabler on Android. */
export function EnvironmentMachineSymbol(props: {
  readonly icon: EnvironmentIcon;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const kind = symbolKind(props.icon);
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
      name={ENVIRONMENT_MACHINE_SYMBOLS[kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}
