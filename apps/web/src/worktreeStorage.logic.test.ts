import { describe, expect, it } from "vite-plus/test";

import {
  computeWorktreeStorageCoverage,
  formatWorktreeStorageBytes,
  planAcrossEnvironmentPrune,
  rankWorktreeEntries,
  rankWorktreeEnvironments,
  rankWorktreeProjects,
  resolveFrozenPrunePlan,
  skippedPruneOutcome,
  summarizePruneOutcomes,
  worktreeDisplayName,
  type WorktreeStorageEnvironmentSummary,
} from "@t3tools/client-runtime/state/worktree-storage";
import { describeWorktreeProtectionReason } from "./worktreeStorage.logic";

function environment(
  input: Partial<WorktreeStorageEnvironmentSummary> &
    Pick<WorktreeStorageEnvironmentSummary, "environmentId" | "label">,
): WorktreeStorageEnvironmentSummary {
  return {
    connectionPhase: "connected",
    capable: true,
    state: "ready",
    totalBytes: 0,
    partial: false,
    ...input,
  };
}

describe("worktree storage aggregation", () => {
  it("formats bytes and protection copy without exposing full paths", () => {
    expect(formatWorktreeStorageBytes(0)).toBe("0 B");
    expect(formatWorktreeStorageBytes(1_572_864)).toBe("1.5 MB");
    expect(worktreeDisplayName("/managed/repo/feature-a")).toBe("feature-a");
    expect(worktreeDisplayName("C:\\managed\\repo\\feature-b")).toBe("feature-b");
    expect(describeWorktreeProtectionReason("dirty-or-untracked")).toBe(
      "Dirty or untracked changes",
    );
    expect(describeWorktreeProtectionReason("unowned-or-orphaned")).toBe(
      "No longer linked to a registered project",
    );
  });

  it("qualifies totals instead of treating missing systems as zero", () => {
    const coverage = computeWorktreeStorageCoverage([
      environment({ environmentId: "a", label: "Alpha", totalBytes: 120 }),
      environment({
        environmentId: "b",
        label: "Beta",
        connectionPhase: "offline",
        state: "offline",
        totalBytes: null,
      }),
      environment({
        environmentId: "c",
        label: "Charlie",
        capable: false,
        state: "unsupported",
        totalBytes: null,
      }),
      environment({
        environmentId: "d",
        label: "Delta",
        state: "error",
        totalBytes: null,
      }),
    ]);

    expect(coverage).toEqual({
      totalKnownBytes: 120,
      knownEnvironmentCount: 1,
      environmentCount: 4,
      loadingCount: 0,
      offlineCount: 1,
      unsupportedCount: 1,
      errorCount: 1,
      partialCount: 0,
      complete: false,
    });
  });

  it("qualifies totals when a system report is partial", () => {
    expect(
      computeWorktreeStorageCoverage([
        environment({ environmentId: "a", label: "Alpha", totalBytes: 120, partial: true }),
      ]),
    ).toMatchObject({
      totalKnownBytes: 120,
      knownEnvironmentCount: 1,
      partialCount: 1,
      complete: false,
    });
  });

  it("ranks systems, projects, and bounded details by bytes with stable ties", () => {
    expect(
      rankWorktreeEnvironments([
        environment({ environmentId: "z", label: "Beta", totalBytes: 20 }),
        environment({ environmentId: "b", label: "Alpha", totalBytes: 20 }),
        environment({ environmentId: "a", label: "Alpha", totalBytes: 20 }),
        environment({ environmentId: "unknown", label: "Unknown", totalBytes: null }),
      ]).map((item) => item.environmentId),
    ).toEqual(["a", "b", "z", "unknown"]);

    expect(
      rankWorktreeProjects([
        { projectId: "z", projectTitle: "Beta", bytes: 20 },
        { projectId: "b", projectTitle: "Alpha", bytes: 20 },
        { projectId: "a", projectTitle: "Alpha", bytes: 20 },
        { projectId: "largest", projectTitle: "Largest", bytes: 30 },
      ]).map((item) => item.projectId),
    ).toEqual(["largest", "a", "b", "z"]);

    expect(
      rankWorktreeEntries([
        { worktreePath: "/z", projectTitle: "Beta", bytes: 20 },
        { worktreePath: "/b", projectTitle: "Alpha", bytes: 20 },
        { worktreePath: "/a", projectTitle: "Alpha", bytes: 20 },
        { worktreePath: "/largest", projectTitle: "Largest", bytes: 30 },
      ]).map((item) => item.worktreePath),
    ).toEqual(["/largest", "/a", "/b", "/z"]);
  });
});

describe("cross-environment pruning", () => {
  it("targets only currently connected capable systems", () => {
    const environments = [
      environment({ environmentId: "ready", label: "Ready" }),
      environment({
        environmentId: "offline",
        label: "Offline",
        connectionPhase: "offline",
        state: "offline",
        totalBytes: null,
      }),
      environment({
        environmentId: "old",
        label: "Old server",
        capable: false,
        state: "unsupported",
        totalBytes: null,
      }),
      environment({
        environmentId: "connecting",
        label: "Connecting",
        connectionPhase: "connecting",
        state: "loading",
        totalBytes: null,
      }),
    ];

    const plan = planAcrossEnvironmentPrune(environments);
    expect(plan.targets.map((item) => item.environmentId)).toEqual(["ready"]);
    expect(plan.skipped.map(skippedPruneOutcome)).toEqual([
      {
        environmentId: "offline",
        label: "Offline",
        status: "skipped",
        reason: "offline",
      },
      {
        environmentId: "old",
        label: "Old server",
        status: "skipped",
        reason: "unsupported",
      },
      {
        environmentId: "connecting",
        label: "Connecting",
        status: "skipped",
        reason: "unavailable",
      },
    ]);
  });

  it("never expands a confirmed prune to a newly connected system", () => {
    const plan = resolveFrozenPrunePlan(
      [
        environment({ environmentId: "confirmed", label: "Confirmed" }),
        environment({ environmentId: "new", label: "New" }),
        environment({
          environmentId: "disconnected",
          label: "Disconnected",
          connectionPhase: "offline",
          state: "offline",
        }),
      ],
      ["confirmed", "disconnected"],
    );

    expect(plan.targets.map((item) => item.environmentId)).toEqual(["confirmed"]);
    expect(plan.skipped.map((item) => item.environmentId)).toEqual(["disconnected"]);
  });

  it("summarizes partial success without hiding protected or failed outcomes", () => {
    expect(
      summarizePruneOutcomes([
        {
          environmentId: "a",
          label: "Alpha",
          status: "success",
          removedCount: 3,
          skippedCount: 2,
          failedCount: 1,
          freedBytes: 120,
          partial: false,
          serverErrorCount: 0,
          unreportedOutcomeCount: 0,
        },
        {
          environmentId: "b",
          label: "Beta",
          status: "skipped",
          reason: "offline",
        },
        {
          environmentId: "c",
          label: "Charlie",
          status: "failure",
          error: "Connection closed",
        },
      ]),
    ).toEqual({
      succeededEnvironmentCount: 1,
      skippedEnvironmentCount: 1,
      failedEnvironmentCount: 1,
      removedCount: 3,
      protectedCount: 2,
      failedWorktreeCount: 1,
      freedBytes: 120,
      partialEnvironmentCount: 0,
      serverErrorCount: 0,
      unreportedOutcomeCount: 0,
      tone: "warning",
    });
  });

  it("warns when a successful server result is partial or omits outcome details", () => {
    expect(
      summarizePruneOutcomes([
        {
          environmentId: "a",
          label: "Alpha",
          status: "success",
          removedCount: 3,
          skippedCount: 0,
          failedCount: 0,
          freedBytes: 120,
          partial: true,
          serverErrorCount: 2,
          unreportedOutcomeCount: 5,
        },
      ]),
    ).toEqual({
      succeededEnvironmentCount: 1,
      skippedEnvironmentCount: 0,
      failedEnvironmentCount: 0,
      removedCount: 3,
      protectedCount: 0,
      failedWorktreeCount: 0,
      freedBytes: 120,
      partialEnvironmentCount: 1,
      serverErrorCount: 2,
      unreportedOutcomeCount: 5,
      tone: "warning",
    });
  });
});
