import type { EnvironmentId, WorktreeStorageProtectionReason } from "@t3tools/contracts";
import {
  formatWorktreeStorageBytes,
  type PruneOutcomeSummary,
} from "@t3tools/client-runtime/state/worktree-storage";

export const MOBILE_WORKTREE_STORAGE_ROUTE = {
  label: "Worktree Storage",
  target: "SettingsWorktreeStorage",
} as const;

export function updatePendingEnvironmentIds(
  current: ReadonlySet<EnvironmentId>,
  environmentId: EnvironmentId,
  pending: boolean,
): ReadonlySet<EnvironmentId> {
  const next = new Set(current);
  if (pending) {
    next.add(environmentId);
  } else {
    next.delete(environmentId);
  }
  return next;
}

const PROTECTION_LABELS: Readonly<Record<WorktreeStorageProtectionReason, string>> = {
  "outside-managed-root": "outside managed storage",
  "shared-across-projects": "shared across projects",
  "main-checkout": "main checkout",
  missing: "missing on disk",
  "locked-or-unknown": "locked or unknown",
  "unowned-or-orphaned": "no registered project",
  "dirty-or-untracked": "dirty or untracked changes",
  "ahead-or-unpushed": "ahead or unpushed commits",
  "unsettled-thread": "unsettled thread",
  "recent-activity": "recent activity",
  "active-turn-or-session": "active turn or session",
  "live-provider": "provider is still running",
  "live-terminal": "terminal is still running",
  "pending-approval": "approval is pending",
  "pending-input": "input is pending",
  "pending-plan": "plan is pending",
  "background-liveness": "background work is running",
  "inspection-error": "safety check incomplete",
};

export function mobileProtectionLabel(reason: WorktreeStorageProtectionReason): string {
  return PROTECTION_LABELS[reason];
}

export function summarizeMobilePrune(summary: PruneOutcomeSummary): string {
  return `${formatWorktreeStorageBytes(summary.freedBytes)} estimated reclaimed · ${summary.removedCount} removed · ${summary.protectedCount} protected · ${summary.failedWorktreeCount} worktree failures · ${summary.partialEnvironmentCount} partial systems · ${summary.serverErrorCount} server errors · ${summary.unreportedOutcomeCount} outcome details omitted · ${summary.skippedEnvironmentCount} systems skipped · ${summary.failedEnvironmentCount} systems failed`;
}
