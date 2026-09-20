import {
  isEnvironmentMachineKind,
  type EnvironmentIcon,
  type EnvironmentMachineKind,
} from "@t3tools/contracts";
import { SymbolView, type AppSymbolName } from "./AppSymbol";

const SYMBOL_BY_KIND: Record<EnvironmentMachineKind, AppSymbolName> = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
};

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
 * The glyph an environment wears in lists; SF Symbols on iOS, Tabler on
 * Android. A name this build cannot draw (picked on a newer client) gets the
 * generic server so the row still reads as a machine.
 */
export function EnvironmentMachineSymbol(props: {
  readonly icon: EnvironmentIcon;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const kind =
    props.icon.kind === "icon" && isEnvironmentMachineKind(props.icon.name)
      ? props.icon.name
      : "server";
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
      name={SYMBOL_BY_KIND[kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}
