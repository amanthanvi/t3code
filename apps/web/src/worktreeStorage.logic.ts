import type { WorktreeStorageProtectionReason } from "@t3tools/contracts";

const PROTECTION_REASON_LABELS = {
  "outside-managed-root": "Outside managed storage",
  "shared-across-projects": "Shared across projects",
  "main-checkout": "Main checkout",
  missing: "Missing on disk",
  "locked-or-unknown": "Locked or unknown",
  "unowned-or-orphaned": "No longer linked to a registered project",
  "dirty-or-untracked": "Dirty or untracked changes",
  "ahead-or-unpushed": "Ahead or unpushed commits",
  "unsettled-thread": "Unsettled thread",
  "recent-activity": "Recently active",
  "active-turn-or-session": "Active turn or session",
  "live-provider": "Provider is still running",
  "live-terminal": "Terminal is still running",
  "pending-approval": "Approval is pending",
  "pending-input": "Input is pending",
  "pending-plan": "Plan is pending",
  "background-liveness": "Background work is running",
  "inspection-error": "Safety check did not complete",
} satisfies Record<WorktreeStorageProtectionReason, string>;

export function describeWorktreeProtectionReason(reason: WorktreeStorageProtectionReason): string {
  return PROTECTION_REASON_LABELS[reason];
}
