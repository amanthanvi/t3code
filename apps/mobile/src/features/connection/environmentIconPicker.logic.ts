import {
  ENVIRONMENT_CURATED_ICON_IDS,
  environmentIconForCuratedId,
  isEnvironmentCuratedIconId,
  isLegacyEnvironmentMachineKind,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
  type EnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";

/**
 * Why the picker is inert, in the order the user can do something about it.
 * Null means it can be changed. Mobile has no per-session scope report to
 * check, so a rejected write surfaces from the command itself.
 */
export function resolveMobileEnvironmentIconLock(serverConfig: ServerConfig | null): string | null {
  if (serverConfig === null) return "Connect to this environment to change its icon.";
  if (serverConfig.environment.capabilities.environmentIcon !== true) {
    return "This environment's server is too old to keep an icon. Update it to choose one.";
  }
  return null;
}

/** Whether the server stores the object form; older servers only take the seven kinds. */
export function supportsRichEnvironmentIcon(serverConfig: ServerConfig | null): boolean {
  return serverConfig?.environment.capabilities.environmentIconOverride === true;
}

export interface MobileEnvironmentIconChoice {
  readonly id: EnvironmentCuratedIconId;
  readonly icon: EnvironmentIcon;
  readonly detected: boolean;
  /** False on a server that rejects the object form. */
  readonly enabled: boolean;
}

/** The curated list as rows, with the detected kind marked and roles gated. */
export function listMobileEnvironmentIconChoices(input: {
  readonly serverConfig: ServerConfig | null;
  readonly detected: EnvironmentMachineKind;
}): ReadonlyArray<MobileEnvironmentIconChoice> {
  const rich = supportsRichEnvironmentIcon(input.serverConfig);
  return ENVIRONMENT_CURATED_ICON_IDS.map((id) => ({
    id,
    icon: environmentIconForCuratedId(id),
    detected: id === input.detected,
    enabled: rich || isLegacyEnvironmentMachineKind(id),
  }));
}

/**
 * What to store for a pick. Picking what the server would draw anyway clears
 * the override, so detection keeps working if the machine changes.
 */
export function resolveMobileEnvironmentIconWrite(input: {
  readonly next: EnvironmentCuratedIconId;
  readonly detected: EnvironmentMachineKind;
}): EnvironmentIcon | null {
  return input.next === input.detected ? null : environmentIconForCuratedId(input.next);
}

/** The curated id a stored override selects in the list, if it is one. */
export function selectedMobileEnvironmentIconId(
  icon: EnvironmentIcon,
): EnvironmentCuratedIconId | null {
  return icon.kind === "icon" && isEnvironmentCuratedIconId(icon.name) ? icon.name : null;
}
