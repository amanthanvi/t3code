import {
  ENVIRONMENT_CURATED_ICON_IDS,
  ENVIRONMENT_ICON_LABELS,
  environmentIconForMachineKind,
  isEnvironmentCuratedIconId,
  isEnvironmentMachineKind,
  resolveEnvironmentIcon,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";

import { Fragment } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

// The curated list starts with the machine kinds; roles follow after a rule.
const ENVIRONMENT_MACHINE_KINDS_COUNT = ENVIRONMENT_CURATED_ICON_IDS.findIndex(
  (id) => !isEnvironmentMachineKind(id),
);

/**
 * Why the picker is inert, in the order the user can do something about it.
 * Null means it can be changed.
 */
export function resolveEnvironmentIconPickerLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.serverConfig.environment.capabilities.environmentIcon !== true) {
    return "This environment's server is too old to keep an icon. Update it to choose one.";
  }
  if (input.operateAccess === "denied") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

/**
 * What to store for a pick. Picking what the server would draw anyway clears
 * the override instead of pinning it, so detection keeps working if the
 * machine changes; a machine kind gets the shared reference, so renderers
 * memoized on the icon do not repaint for the same pick.
 */
export function resolveEnvironmentIconWrite(input: {
  readonly next: EnvironmentCuratedIconId;
  readonly detected: EnvironmentMachineKind;
}): EnvironmentIcon | null {
  if (input.next === input.detected) return null;
  // A plain machine kind encodes to the bare string on the wire, so a server
  // that predates the object form accepts it unchanged; a role stays an object.
  return isEnvironmentMachineKind(input.next)
    ? environmentIconForMachineKind(input.next)
    : { kind: "icon", name: input.next };
}

/**
 * Only the seven machine kinds have a string form an older server accepts;
 * a role travels as the object, which such a server rejects. Null means the
 * id can be picked.
 */
export function resolveEnvironmentIconChoiceLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly id: EnvironmentCuratedIconId;
}): string | null {
  if (isEnvironmentMachineKind(input.id)) return null;
  return input.serverConfig?.environment.capabilities.environmentIconOverride === true
    ? null
    : "Update this environment's server to pick an icon beyond its machine kind.";
}

// Same split the provider settings use: the desktop app owns its primary
// server outright, a browser session on the primary checks its cookie
// session's scopes, and a remote checks the scopes its own server reports.
function useEnvironmentOperateAccess(environmentId: EnvironmentId) {
  const isPrimary = usePrimaryEnvironmentId() === environmentId;
  const primarySession = usePrimarySessionState();
  const remoteSession = useEnvironmentSessionState(environmentId);
  if (isPrimary) {
    return isElectron
      ? "granted"
      : resolvePrimaryOperateAccess({
          isPrimary: true,
          hasDesktopBridge: false,
          session: primarySession.data,
          isPending: primarySession.isPending,
          hasError: primarySession.error !== null,
        });
  }
  return resolveRemoteOperateAccess({
    session: remoteSession.data,
    isPending: remoteSession.isPending,
    hasError: remoteSession.hasError,
  });
}

/**
 * Why a pick is unavailable, shown as a disabled row so the list still reads.
 * Both the whole-submenu lock and the role-section lock render one of these.
 */
function IconLockNotice({ reason }: { readonly reason: string }) {
  return (
    <MenuItem disabled className="whitespace-normal">
      {reason}
    </MenuItem>
  );
}

/**
 * "Icon" submenu for an environment's row menu. Lists the curated icons with
 * the server's own detection marked, so the user can tell whether detection
 * got it right before overriding. Picking the detected kind clears the
 * override. Locked environments show the reason as a disabled item instead of
 * hiding the submenu, so the current icon still reads.
 */
export function EnvironmentIconMenu({
  environmentId,
  serverConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess });
  // With no detection the server falls back to "server", so picking that
  // kind clears the override the same way picking the detected kind does.
  const detected = serverConfig?.environment.platform.machine ?? "server";
  const resolved = resolveEnvironmentIcon(serverConfig);
  // The radio list only knows the curated ids; a richer pick checks nothing.
  const resolvedId =
    resolved.kind === "icon" && isEnvironmentCuratedIconId(resolved.name) ? resolved.name : null;
  const roleLock = lock ?? resolveEnvironmentIconChoiceLock({ serverConfig, id: "terminal" });

  return (
    <MenuSub>
      <MenuSubTrigger>
        <EnvironmentMachineIcon icon={resolved} />
        Icon
      </MenuSubTrigger>
      <MenuSubPopup>
        {lock !== null ? (
          <>
            <IconLockNotice reason={lock} />
            <MenuSeparator />
          </>
        ) : null}
        <MenuRadioGroup
          value={resolvedId}
          onValueChange={(next) => {
            if (!isEnvironmentCuratedIconId(next)) return;
            if (resolveEnvironmentIconChoiceLock({ serverConfig, id: next }) !== null) return;
            if (lock !== null) return;
            updateSettings({ environmentIcon: resolveEnvironmentIconWrite({ next, detected }) });
          }}
        >
          {ENVIRONMENT_CURATED_ICON_IDS.map((id, index) => (
            <Fragment key={id}>
              {index === ENVIRONMENT_MACHINE_KINDS_COUNT ? (
                <>
                  <MenuSeparator />
                  {lock === null && roleLock !== null ? <IconLockNotice reason={roleLock} /> : null}
                </>
              ) : null}
              <MenuRadioItem
                value={id}
                disabled={
                  lock !== null || resolveEnvironmentIconChoiceLock({ serverConfig, id }) !== null
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    icon={
                      isEnvironmentMachineKind(id)
                        ? environmentIconForMachineKind(id)
                        : { kind: "icon", name: id }
                    }
                    className="size-3.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{ENVIRONMENT_ICON_LABELS[id]}</span>
                  {id === detected ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {serverConfig?.environment.platform.machine ? "detected" : "default"}
                    </span>
                  ) : null}
                </span>
              </MenuRadioItem>
            </Fragment>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}
