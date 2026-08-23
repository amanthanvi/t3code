import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const WORKTREE_STORAGE_MAX_PROJECTS = 100;
export const WORKTREE_STORAGE_MAX_DETAILS = 200;
export const WORKTREE_STORAGE_MAX_OUTCOMES = 200;
export const WORKTREE_STORAGE_MAX_ERRORS = 50;
export const WORKTREE_STORAGE_MAX_ASSOCIATED_THREAD_IDS = 25;
export const WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS = 1;
export const WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS = 365;

const WorktreeStorageByteCount = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const WorktreeStoragePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const WorktreeStorageMessage = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));

export const WorktreeAutoPruneInactivityDays = Schema.Int.check(
  Schema.isBetween({
    minimum: WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS,
    maximum: WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS,
  }),
);
export type WorktreeAutoPruneInactivityDays = typeof WorktreeAutoPruneInactivityDays.Type;

export const WorktreeAutoPrunePolicy = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("off") }),
  Schema.Struct({ mode: Schema.Literal("on-settle") }),
  Schema.Struct({
    mode: Schema.Literal("after-inactive-days"),
    inactivityDays: WorktreeAutoPruneInactivityDays,
  }),
]);
export type WorktreeAutoPrunePolicy = typeof WorktreeAutoPrunePolicy.Type;

export const DEFAULT_WORKTREE_AUTO_PRUNE_POLICY: WorktreeAutoPrunePolicy = { mode: "off" };

/** Path-free trigger payload. Unknown runtime fields are rejected instead of preserved. */
export const WorktreeStorageRequest = Schema.Struct({}).check(
  Schema.makeFilter(
    (input) => Object.keys(input).length === 0 || "worktree storage requests accept no fields",
  ),
);
export type WorktreeStorageRequest = typeof WorktreeStorageRequest.Type;

export const WorktreeStorageProtectionReason = Schema.Literals([
  "outside-managed-root",
  "shared-across-projects",
  "main-checkout",
  "missing",
  "locked-or-unknown",
  "dirty-or-untracked",
  "ahead-or-unpushed",
  "unsettled-thread",
  "recent-activity",
  "active-turn-or-session",
  "live-provider",
  "live-terminal",
  "pending-approval",
  "pending-input",
  "pending-plan",
  "background-liveness",
  "unowned-or-orphaned",
  "inspection-error",
]);
export type WorktreeStorageProtectionReason = typeof WorktreeStorageProtectionReason.Type;

export const WorktreeStorageScanError = Schema.Struct({
  path: Schema.optionalKey(WorktreeStoragePath),
  operation: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  message: WorktreeStorageMessage,
});
export type WorktreeStorageScanError = typeof WorktreeStorageScanError.Type;

export const WorktreeStorageDetail = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  projectTitle: TrimmedNonEmptyString,
  worktreePath: WorktreeStoragePath,
  bytes: WorktreeStorageByteCount,
  associatedThreadCount: NonNegativeInt,
  associatedThreadIds: Schema.Array(ThreadId).check(
    Schema.isMaxLength(WORKTREE_STORAGE_MAX_ASSOCIATED_THREAD_IDS),
  ),
  latestActivityAt: Schema.NullOr(IsoDateTime),
  stale: Schema.Boolean,
  eligible: Schema.Boolean,
  protectionReasons: Schema.Array(WorktreeStorageProtectionReason),
  scanErrors: Schema.Array(WorktreeStorageScanError).check(
    Schema.isMaxLength(WORKTREE_STORAGE_MAX_ERRORS),
  ),
});
export type WorktreeStorageDetail = typeof WorktreeStorageDetail.Type;

export const WorktreeStorageProjectAggregate = Schema.Struct({
  projectId: ProjectId,
  projectTitle: TrimmedNonEmptyString,
  bytes: WorktreeStorageByteCount,
  worktreeCount: NonNegativeInt,
  staleWorktreeCount: NonNegativeInt,
  eligibleWorktreeCount: NonNegativeInt,
});
export type WorktreeStorageProjectAggregate = typeof WorktreeStorageProjectAggregate.Type;

export const WorktreeStorageReport = Schema.Struct({
  scannedAt: IsoDateTime,
  totalBytes: WorktreeStorageByteCount,
  worktreeCount: NonNegativeInt,
  staleWorktreeCount: NonNegativeInt,
  eligibleWorktreeCount: NonNegativeInt,
  projects: Schema.Array(WorktreeStorageProjectAggregate).check(
    Schema.isMaxLength(WORKTREE_STORAGE_MAX_PROJECTS),
  ),
  projectCount: NonNegativeInt,
  details: Schema.Array(WorktreeStorageDetail).check(
    Schema.isMaxLength(WORKTREE_STORAGE_MAX_DETAILS),
  ),
  detailCount: NonNegativeInt,
  errors: Schema.Array(WorktreeStorageScanError).check(
    Schema.isMaxLength(WORKTREE_STORAGE_MAX_ERRORS),
  ),
  partial: Schema.Boolean,
});
export type WorktreeStorageReport = typeof WorktreeStorageReport.Type;

export const WorktreeStoragePruneOutcome = Schema.Struct({
  worktreePath: WorktreeStoragePath,
  projectId: Schema.NullOr(ProjectId),
  bytes: WorktreeStorageByteCount,
  status: Schema.Literals(["removed", "skipped", "failed"]),
  protectionReasons: Schema.Array(WorktreeStorageProtectionReason),
  message: Schema.optionalKey(WorktreeStorageMessage),
});
export type WorktreeStoragePruneOutcome = typeof WorktreeStoragePruneOutcome.Type;

export const WorktreeStoragePruneResult = Schema.Struct({
  startedAt: IsoDateTime,
  completedAt: IsoDateTime,
  removedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  failedCount: NonNegativeInt,
  reclaimedBytes: WorktreeStorageByteCount,
  outcomes: Schema.Array(WorktreeStoragePruneOutcome).check(
    Schema.isMaxLength(WORKTREE_STORAGE_MAX_OUTCOMES),
  ),
  outcomeCount: NonNegativeInt,
  errors: Schema.Array(WorktreeStorageScanError).check(
    Schema.isMaxLength(WORKTREE_STORAGE_MAX_ERRORS),
  ),
  partial: Schema.Boolean,
});
export type WorktreeStoragePruneResult = typeof WorktreeStoragePruneResult.Type;

export class WorktreeStorageError extends Schema.TaggedErrorClass<WorktreeStorageError>()(
  "WorktreeStorageError",
  {
    operation: Schema.Literals(["report", "prune"]),
    message: WorktreeStorageMessage,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
