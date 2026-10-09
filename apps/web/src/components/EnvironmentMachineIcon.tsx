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
import { cn } from "~/lib/utils";
import { projectIconColorClassName } from "../projectIconColors";
import { LinuxIcon } from "./Icons";
import { ProjectMonogram } from "./ProjectMonogram";

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

export interface EnvironmentMachineIconProps {
  readonly className?: string | undefined;
  readonly "aria-hidden"?: boolean | "true" | "false" | undefined;
}

/**
 * The glyph an environment wears. `className` sizes it and carries the
 * caller's resting tint, and a chosen color is merged after that tint so it
 * wins. Rows draw connection state beside the glyph (a dot, the subtitle, or
 * dimming the whole row), never on it, so a red icon never reads as a failed
 * one. Emoji and monograms carry a plain `size-4` so a caller's size always
 * wins; a responsive base like the menu's `size-4.5 sm:size-4` would survive
 * the merge as a separate variant and re-grow the icon at the breakpoint.
 * Text-bearing variants are hidden from assistive technology like the svg
 * ones are; the row's label already names the machine.
 */
export function EnvironmentMachineIcon({
  icon,
  className,
  ...props
}: EnvironmentMachineIconProps & { readonly icon: EnvironmentIcon }) {
  if (icon.kind === "emoji") {
    return (
      <span
        aria-hidden="true"
        {...props}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center leading-none [container-type:size]",
          className,
        )}
      >
        <span className="text-[length:80cqh] leading-none">{icon.emoji}</span>
      </span>
    );
  }
  if (icon.kind === "monogram") {
    return <ProjectMonogram text={icon.text} color={icon.color ?? "gray"} className={className} />;
  }
  const Icon = ICON_BY_ID[curatedIconId(icon)];
  const color = icon.kind === "icon" && icon.color !== undefined ? icon.color : undefined;
  return (
    <Icon
      {...props}
      className={color === undefined ? className : cn(className, projectIconColorClassName(color))}
    />
  );
}

const COMPONENT_BY_ICON = new WeakMap<
  EnvironmentIcon,
  FunctionComponent<EnvironmentMachineIconProps>
>();

/**
 * The glyph as a standalone component, for slots that take one such as the
 * pull request filter menu. Keyed on the icon object, which
 * `resolveEnvironmentIcon` returns by reference for a stored override and
 * memoizes per machine kind for a detected one, so every render between two
 * settings changes hits. A menu that rebuilds its option array on each
 * keystroke therefore keeps one component identity per environment and its
 * icon subtree does not remount.
 */
export function environmentMachineIcon(
  icon: EnvironmentIcon,
): FunctionComponent<EnvironmentMachineIconProps> {
  const cached = COMPONENT_BY_ICON.get(icon);
  if (cached !== undefined) return cached;
  const Component: FunctionComponent<EnvironmentMachineIconProps> = (props) => (
    <EnvironmentMachineIcon icon={icon} {...props} />
  );
  Component.displayName = `EnvironmentMachineIcon(${icon.kind})`;
  COMPONENT_BY_ICON.set(icon, Component);
  return Component;
}
