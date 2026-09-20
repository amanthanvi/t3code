import { resolveEnvironmentIcon, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MenuItem } from "../ui/menu";
import { resolveEnvironmentIconPickerLock } from "./EnvironmentIconPicker.logic";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

const EnvironmentIconPickerDialog = lazy(() =>
  import("./EnvironmentIconPickerDialog").then((module) => ({
    default: module.EnvironmentIconPickerDialog,
  })),
);

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
 * "Change icon" item for an environment's row menu. Locked environments keep
 * the item, disabled, and print the reason beneath it: a disabled menu item
 * takes no pointer events, so nothing hover-based could carry the text. The
 * dialog itself is `EnvironmentIconPickerHost`, mounted beside the menu: a
 * menu popup unmounts its children when it closes, which is the moment this
 * item is clicked.
 */
export function EnvironmentIconMenuItem({
  environmentId,
  serverConfig,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig | null;
  readonly onOpen: () => void;
}) {
  const operateAccess = useEnvironmentOperateAccess(environmentId);
  const lock = resolveEnvironmentIconPickerLock({ serverConfig, operateAccess });
  return (
    <>
      <MenuItem disabled={lock !== null} onClick={onOpen}>
        <EnvironmentMachineIcon icon={resolveEnvironmentIcon(serverConfig)} />
        Change icon…
      </MenuItem>
      {lock !== null ? (
        <MenuItem disabled className="whitespace-normal">
          {lock}
        </MenuItem>
      ) : null}
    </>
  );
}

/** The picker dialog for one environment, loaded only while open. */
export function EnvironmentIconPickerHost({
  environmentId,
  environmentLabel,
  serverConfig,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly serverConfig: ServerConfig | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <EnvironmentIconPickerDialog
        current={resolveEnvironmentIcon(serverConfig)}
        // With no detection the server falls back to "server", so picking that
        // kind clears the override the same way picking the detected kind does.
        detected={serverConfig?.environment.platform.machine ?? "server"}
        environmentLabel={environmentLabel}
        serverConfig={serverConfig}
        open
        onOpenChange={onOpenChange}
        onSelect={(environmentIcon) => updateSettings({ environmentIcon })}
      />
    </Suspense>
  );
}
