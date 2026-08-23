import type { WorktreeStoragePruneResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computeWorktreeStorageCoverage,
  planAcrossEnvironmentPrune,
  resolveFrozenPrunePlan,
  successfulPruneOutcome,
  summarizePruneOutcomes,
  type WorktreeStorageEnvironmentSummary,
} from "./worktreeStorageDomain.ts";

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

describe("worktree storage domain", () => {
  it("qualifies partial and missing environment coverage", () => {
    expect(
      computeWorktreeStorageCoverage([
        environment({ environmentId: "partial", label: "Partial", totalBytes: 120, partial: true }),
        environment({
          environmentId: "offline",
          label: "Offline",
          connectionPhase: "offline",
          state: "offline",
          totalBytes: null,
        }),
      ]),
    ).toEqual({
      totalKnownBytes: 120,
      knownEnvironmentCount: 1,
      environmentCount: 2,
      loadingCount: 0,
      offlineCount: 1,
      unsupportedCount: 0,
      errorCount: 0,
      partialCount: 1,
      complete: false,
    });
  });

  it("freezes destructive scope while allowing confirmed systems to become skipped", () => {
    const environments = [
      environment({ environmentId: "confirmed", label: "Confirmed" }),
      environment({ environmentId: "new", label: "New" }),
      environment({
        environmentId: "disconnected",
        label: "Disconnected",
        connectionPhase: "offline",
        state: "offline",
      }),
    ];

    expect(planAcrossEnvironmentPrune(environments).targets).toHaveLength(2);
    const resolved = resolveFrozenPrunePlan(environments, ["confirmed", "disconnected"]);
    expect(resolved.targets.map((item) => item.environmentId)).toEqual(["confirmed"]);
    expect(resolved.skipped.map((item) => item.environmentId)).toEqual(["disconnected"]);
  });

  it("preserves partial server results and omitted outcome counts in aggregation", () => {
    const result: WorktreeStoragePruneResult = {
      startedAt: "2026-08-23T12:00:00.000Z",
      completedAt: "2026-08-23T12:00:01.000Z",
      removedCount: 2,
      skippedCount: 1,
      failedCount: 0,
      reclaimedBytes: 1_024,
      partial: true,
      errors: [{ operation: "scan", message: "One worktree could not be inspected" }],
      outcomeCount: 3,
      outcomes: [
        {
          worktreePath: "/managed/feature",
          projectId: null,
          bytes: 1_024,
          status: "removed",
          protectionReasons: [],
        },
      ],
    };
    const outcome = successfulPruneOutcome(
      environment({ environmentId: "ready", label: "Ready" }),
      result,
    );

    expect(summarizePruneOutcomes([outcome])).toMatchObject({
      removedCount: 2,
      protectedCount: 1,
      freedBytes: 1_024,
      partialEnvironmentCount: 1,
      serverErrorCount: 1,
      unreportedOutcomeCount: 2,
      tone: "warning",
    });
  });
});
