import {
  environmentIconForCuratedId,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
  type EnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";

/**
 * Why an environment's icon cannot be changed from this client, in the order
 * the user can do something about it. Null means it can be changed. A
 * switched-off or dropped environment keeps its last config, so the
 * connection is checked before the server's capabilities.
 */
export function resolveEnvironmentIconLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly connected: boolean;
  readonly canWriteSettings: boolean;
}): string | null {
  if (!input.connected || input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.serverConfig.environment.capabilities.environmentIcon !== true) {
    return "This environment's server is too old to keep an icon. Update it to choose one.";
  }
  if (!input.canWriteSettings) {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

/**
 * Why anything beyond a plain legacy machine kind (a role, `container`, a
 * color, an emoji, a monogram, or an image) cannot be written to this server;
 * null when it can.
 */
export function resolveEnvironmentRichIconLock(serverConfig: ServerConfig | null): string | null {
  return serverConfig?.environment.capabilities.environmentIconOverride === true
    ? null
    : "Update this environment's server to pick an icon beyond its machine kind.";
}

/**
 * What to store for a plain named pick. Picking what the server would draw
 * anyway clears the override instead of pinning it, so detection keeps
 * working if the machine changes.
 */
export function resolveEnvironmentIconPick(input: {
  readonly next: EnvironmentCuratedIconId;
  readonly detected: EnvironmentMachineKind;
}): EnvironmentIcon | null {
  return input.next === input.detected ? null : environmentIconForCuratedId(input.next);
}
