import { resolveEnvironmentRichIconLock } from "@t3tools/client-runtime/environment-icon";
import {
  ENVIRONMENT_CURATED_ICON_IDS,
  environmentIconForCuratedId,
  isLegacyEnvironmentMachineKind,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
  type EnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";

export interface MobileEnvironmentIconChoice {
  readonly id: EnvironmentCuratedIconId;
  readonly icon: EnvironmentIcon;
  readonly detected: boolean;
  /** False on a server that rejects the object form. */
  readonly enabled: boolean;
}

/**
 * The curated list as rows, with the detected kind marked. Anything without a
 * legacy string form, a role or `container`, is gated on the object form.
 */
export function listMobileEnvironmentIconChoices(input: {
  readonly serverConfig: ServerConfig | null;
  readonly detected: EnvironmentMachineKind;
}): ReadonlyArray<MobileEnvironmentIconChoice> {
  const rich = resolveEnvironmentRichIconLock(input.serverConfig) === null;
  return ENVIRONMENT_CURATED_ICON_IDS.map((id) => ({
    id,
    icon: environmentIconForCuratedId(id),
    detected: id === input.detected,
    enabled: rich || isLegacyEnvironmentMachineKind(id),
  }));
}
