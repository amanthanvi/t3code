import {
  isEnvironmentCuratedIconId,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
} from "@t3tools/contracts";
import {
  BrainIcon,
  CloudIcon,
  ContainerIcon,
  DatabaseIcon,
  GlobeIcon,
  HouseIcon,
  LaptopIcon,
  MonitorIcon,
  NetworkIcon,
  ServerIcon,
  TerminalIcon,
  type LucideProps,
} from "lucide-react";
import type { FunctionComponent, SVGProps } from "react";
import { LinuxIcon } from "./Icons";

// Lucide has no Apple desktops, so these two are drawn to its grammar (24
// unit grid, 2 unit stroke, round joins) and share its prop surface so callers
// can swap freely.
function LucideLike(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

/** A Mac mini: squat rounded slab with a front-edge LED. */
function MacMiniIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="20" height="8" x="2" y="8" rx="2" />
      <path d="M6 12h.01" />
    </LucideLike>
  );
}

/** A Mac Studio: the same slab twice as tall, ports along the front foot. */
function MacStudioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
    </LucideLike>
  );
}

const ICON_BY_ID: Record<EnvironmentCuratedIconId, FunctionComponent<LucideProps>> = {
  server: ServerIcon,
  cloud: CloudIcon,
  linux: LinuxIcon,
  desktop: MonitorIcon,
  laptop: LaptopIcon,
  "mac-mini": MacMiniIcon,
  "mac-studio": MacStudioIcon,
  terminal: TerminalIcon,
  database: DatabaseIcon,
  container: ContainerIcon,
  globe: GlobeIcon,
  home: HouseIcon,
  gpu: BrainIcon,
  network: NetworkIcon,
};

/**
 * Which curated glyph draws a named icon. A name this build cannot draw
 * (picked on a newer client) gets the generic server so the row still reads
 * as a machine.
 */
function curatedIconId(icon: EnvironmentIcon): EnvironmentCuratedIconId {
  return icon.kind === "icon" && isEnvironmentCuratedIconId(icon.name) ? icon.name : "server";
}

export function environmentMachineIcon(icon: EnvironmentIcon): FunctionComponent<LucideProps> {
  return ICON_BY_ID[curatedIconId(icon)];
}

export function EnvironmentMachineIcon({
  icon,
  ...props
}: LucideProps & { readonly icon: EnvironmentIcon }) {
  const Icon = ICON_BY_ID[curatedIconId(icon)];
  return <Icon {...props} />;
}
