import type { WorktreeStoragePruneResult } from "@t3tools/contracts";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

export type WorktreeStorageEnvironmentState =
  | "loading"
  | "ready"
  | "offline"
  | "unsupported"
  | "error";

export interface WorktreeStorageEnvironmentSummary {
  readonly environmentId: string;
  readonly label: string;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly capable: boolean;
  readonly state: WorktreeStorageEnvironmentState;
  readonly totalBytes: number | null;
  readonly partial: boolean;
}

export interface WorktreeStorageCoverage {
  readonly totalKnownBytes: number;
  readonly knownEnvironmentCount: number;
  readonly environmentCount: number;
  readonly loadingCount: number;
  readonly offlineCount: number;
  readonly unsupportedCount: number;
  readonly errorCount: number;
  readonly partialCount: number;
  readonly complete: boolean;
}

export interface WorktreeStorageProjectLike {
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly bytes: number;
}

export interface WorktreeStorageEntryLike {
  readonly worktreePath: string;
  readonly projectTitle: string;
  readonly bytes: number;
}

export interface WorktreeStoragePrunePlan<T extends WorktreeStorageEnvironmentSummary> {
  readonly targets: readonly T[];
  readonly skipped: readonly T[];
}

export type WorktreeStorageSkippedReason = "offline" | "unsupported" | "unavailable";

export type EnvironmentPruneOutcome =
  | {
      readonly environmentId: string;
      readonly label: string;
      readonly status: "success";
      readonly removedCount: number;
      readonly skippedCount: number;
      readonly failedCount: number;
      readonly freedBytes: number;
      readonly partial: boolean;
      readonly serverErrorCount: number;
      readonly unreportedOutcomeCount: number;
    }
  | {
      readonly environmentId: string;
      readonly label: string;
      readonly status: "skipped";
      readonly reason: WorktreeStorageSkippedReason;
    }
  | {
      readonly environmentId: string;
      readonly label: string;
      readonly status: "failure";
      readonly error: string;
    };

export interface PruneOutcomeSummary {
  readonly succeededEnvironmentCount: number;
  readonly skippedEnvironmentCount: number;
  readonly failedEnvironmentCount: number;
  readonly removedCount: number;
  readonly protectedCount: number;
  readonly failedWorktreeCount: number;
  readonly freedBytes: number;
  readonly partialEnvironmentCount: number;
  readonly serverErrorCount: number;
  readonly unreportedOutcomeCount: number;
  readonly tone: "success" | "warning" | "error";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatWorktreeStorageBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const maximumFractionDigits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)} ${BYTE_UNITS[unitIndex]}`;
}

export function worktreeDisplayName(path: string): string {
  return path.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? "Worktree";
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNullableText(left: string | null, right: string | null): number {
  return compareText(left ?? "", right ?? "");
}

/** Known byte totals rank first; labels and ids make equal-byte ordering deterministic. */
export function rankWorktreeEnvironments<T extends WorktreeStorageEnvironmentSummary>(
  environments: readonly T[],
): readonly T[] {
  return environments.toSorted((left, right) => {
    if (left.totalBytes === null && right.totalBytes !== null) return 1;
    if (left.totalBytes !== null && right.totalBytes === null) return -1;
    if (left.totalBytes !== null && right.totalBytes !== null) {
      const byteOrder = right.totalBytes - left.totalBytes;
      if (byteOrder !== 0) return byteOrder;
    }
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0 ? labelOrder : compareText(left.environmentId, right.environmentId);
  });
}

export function rankWorktreeProjects<T extends WorktreeStorageProjectLike>(
  projects: readonly T[],
): readonly T[] {
  return projects.toSorted((left, right) => {
    const byteOrder = right.bytes - left.bytes;
    if (byteOrder !== 0) return byteOrder;
    const titleOrder = compareNullableText(left.projectTitle, right.projectTitle);
    return titleOrder !== 0 ? titleOrder : compareNullableText(left.projectId, right.projectId);
  });
}

export function rankWorktreeEntries<T extends WorktreeStorageEntryLike>(
  entries: readonly T[],
): readonly T[] {
  return entries.toSorted((left, right) => {
    const byteOrder = right.bytes - left.bytes;
    if (byteOrder !== 0) return byteOrder;
    const titleOrder = compareText(left.projectTitle, right.projectTitle);
    return titleOrder !== 0 ? titleOrder : compareText(left.worktreePath, right.worktreePath);
  });
}

/** Missing and partial reports stay qualified; they never contribute a fabricated zero. */
export function computeWorktreeStorageCoverage(
  environments: readonly WorktreeStorageEnvironmentSummary[],
): WorktreeStorageCoverage {
  const known = environments.filter(
    (environment) => environment.state === "ready" && environment.totalBytes !== null,
  );
  const count = (state: WorktreeStorageEnvironmentState) =>
    environments.filter((environment) => environment.state === state).length;
  const partialCount = known.filter((environment) => environment.partial).length;

  return {
    totalKnownBytes: known.reduce((sum, environment) => sum + (environment.totalBytes ?? 0), 0),
    knownEnvironmentCount: known.length,
    environmentCount: environments.length,
    loadingCount: count("loading"),
    offlineCount: count("offline"),
    unsupportedCount: count("unsupported"),
    errorCount: count("error"),
    partialCount,
    complete: known.length === environments.length && partialCount === 0,
  };
}

/** Across-system pruning dispatches only to systems that can answer right now. */
export function planAcrossEnvironmentPrune<T extends WorktreeStorageEnvironmentSummary>(
  environments: readonly T[],
): WorktreeStoragePrunePlan<T> {
  const targets: T[] = [];
  const skipped: T[] = [];
  for (const environment of environments) {
    if (environment.connectionPhase === "connected" && environment.capable) {
      targets.push(environment);
    } else {
      skipped.push(environment);
    }
  }
  return { targets, skipped };
}

/** A confirmed prune may narrow as systems disconnect, but never expands to new systems. */
export function resolveFrozenPrunePlan<T extends WorktreeStorageEnvironmentSummary>(
  environments: readonly T[],
  confirmedEnvironmentIds: readonly string[],
): WorktreeStoragePrunePlan<T> {
  const confirmed = new Set(confirmedEnvironmentIds);
  return planAcrossEnvironmentPrune(
    environments.filter((environment) => confirmed.has(environment.environmentId)),
  );
}

export function worktreeStorageSkippedReason(
  environment: WorktreeStorageEnvironmentSummary,
): WorktreeStorageSkippedReason {
  if (environment.state === "loading") return "unavailable";
  if (environment.connectionPhase === "offline") return "offline";
  if (environment.connectionPhase !== "connected") return "unavailable";
  return environment.capable ? "unavailable" : "unsupported";
}

export function skippedPruneOutcome(
  environment: WorktreeStorageEnvironmentSummary,
): EnvironmentPruneOutcome {
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    status: "skipped",
    reason: worktreeStorageSkippedReason(environment),
  };
}

export function successfulPruneOutcome(
  environment: Pick<WorktreeStorageEnvironmentSummary, "environmentId" | "label">,
  result: WorktreeStoragePruneResult,
): EnvironmentPruneOutcome {
  return {
    environmentId: environment.environmentId,
    label: environment.label,
    status: "success",
    removedCount: result.removedCount,
    skippedCount: result.skippedCount,
    failedCount: result.failedCount,
    freedBytes: result.reclaimedBytes,
    partial: result.partial,
    serverErrorCount: result.errors.length,
    unreportedOutcomeCount: Math.max(0, result.outcomeCount - result.outcomes.length),
  };
}

export function summarizePruneOutcomes(
  outcomes: readonly EnvironmentPruneOutcome[],
): PruneOutcomeSummary {
  const successful = outcomes.filter((outcome) => outcome.status === "success");
  const skippedEnvironmentCount = outcomes.filter((outcome) => outcome.status === "skipped").length;
  const failedEnvironmentCount = outcomes.filter((outcome) => outcome.status === "failure").length;
  const removedCount = successful.reduce((sum, outcome) => sum + outcome.removedCount, 0);
  const protectedCount = successful.reduce((sum, outcome) => sum + outcome.skippedCount, 0);
  const failedWorktreeCount = successful.reduce((sum, outcome) => sum + outcome.failedCount, 0);
  const freedBytes = successful.reduce((sum, outcome) => sum + outcome.freedBytes, 0);
  const partialEnvironmentCount = successful.filter((outcome) => outcome.partial).length;
  const serverErrorCount = successful.reduce((sum, outcome) => sum + outcome.serverErrorCount, 0);
  const unreportedOutcomeCount = successful.reduce(
    (sum, outcome) => sum + outcome.unreportedOutcomeCount,
    0,
  );
  const hasWarning =
    skippedEnvironmentCount > 0 ||
    failedEnvironmentCount > 0 ||
    failedWorktreeCount > 0 ||
    partialEnvironmentCount > 0 ||
    serverErrorCount > 0 ||
    unreportedOutcomeCount > 0;

  return {
    succeededEnvironmentCount: successful.length,
    skippedEnvironmentCount,
    failedEnvironmentCount,
    removedCount,
    protectedCount,
    failedWorktreeCount,
    freedBytes,
    partialEnvironmentCount,
    serverErrorCount,
    unreportedOutcomeCount,
    tone:
      failedEnvironmentCount === outcomes.length && outcomes.length > 0
        ? "error"
        : hasWarning
          ? "warning"
          : "success",
  };
}
