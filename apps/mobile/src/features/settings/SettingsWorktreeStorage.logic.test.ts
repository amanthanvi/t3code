import type { EnvironmentId } from "@t3tools/contracts";
import {
  computeWorktreeStorageCoverage,
  formatWorktreeStorageBytes,
  planAcrossEnvironmentPrune,
  summarizePruneOutcomes,
  worktreeDisplayName,
  worktreeStorageSkippedReason,
} from "@t3tools/client-runtime/state/worktree-storage";
import { describe, expect, it } from "vite-plus/test";

import {
  beginPendingPolicyUpdate,
  MOBILE_WORKTREE_STORAGE_ROUTE,
  mobileProtectionLabel,
  reconcileConfirmedMobilePrunePlan,
  summarizeMobilePrune,
  updatePendingEnvironmentIds,
} from "./SettingsWorktreeStorage.logic";
import type { MobileEnvironmentWorktreeStorageStatus } from "../../state/worktree-storage";

function environment(
  input: Partial<MobileEnvironmentWorktreeStorageStatus> &
    Pick<MobileEnvironmentWorktreeStorageStatus, "environmentId" | "label">,
): MobileEnvironmentWorktreeStorageStatus {
  return {
    connectionPhase: "connected",
    capable: true,
    state: "ready",
    totalBytes: input.report?.totalBytes ?? null,
    partial: input.report?.partial ?? false,
    report: null,
    policy: { mode: "off" },
    isRefreshing: false,
    error: null,
    ...input,
  };
}

describe("mobile worktree storage presentation", () => {
  it("rejects a duplicate policy update before the first update finishes", () => {
    const environmentId = "first" as EnvironmentId;
    const pending = beginPendingPolicyUpdate(new Set(), environmentId);

    expect({
      pending: [...(pending ?? [])],
      duplicate: beginPendingPolicyUpdate(pending!, environmentId),
    }).toEqual({ pending: [environmentId], duplicate: null });
  });

  it("tracks overlapping policy updates independently when they finish out of order", () => {
    const firstEnvironmentId = "first" as EnvironmentId;
    const secondEnvironmentId = "second" as EnvironmentId;
    let pendingEnvironmentIds: ReadonlySet<EnvironmentId> = new Set();

    pendingEnvironmentIds = beginPendingPolicyUpdate(pendingEnvironmentIds, firstEnvironmentId)!;
    pendingEnvironmentIds = beginPendingPolicyUpdate(pendingEnvironmentIds, secondEnvironmentId)!;
    pendingEnvironmentIds = updatePendingEnvironmentIds(
      pendingEnvironmentIds,
      firstEnvironmentId,
      false,
    );

    expect([...pendingEnvironmentIds]).toEqual([secondEnvironmentId]);
    expect(
      updatePendingEnvironmentIds(pendingEnvironmentIds, secondEnvironmentId, false).size,
    ).toBe(0);
  });

  it("keeps Worktree Storage distinct from Client Storage", () => {
    expect(MOBILE_WORKTREE_STORAGE_ROUTE).toEqual({
      label: "Worktree Storage",
      target: "SettingsWorktreeStorage",
    });
    expect(MOBILE_WORKTREE_STORAGE_ROUTE.label).not.toBe("Client Storage");
  });

  it("qualifies totals and targets only connected capable systems", () => {
    const environments = [
      environment({
        environmentId: "ready" as EnvironmentId,
        label: "Ready",
        report: { totalBytes: 1_048_576 } as MobileEnvironmentWorktreeStorageStatus["report"],
      }),
      environment({
        environmentId: "offline" as EnvironmentId,
        label: "Offline",
        connectionPhase: "offline",
        state: "offline",
      }),
      environment({
        environmentId: "old" as EnvironmentId,
        label: "Old",
        capable: false,
        state: "unsupported",
      }),
    ];

    expect(computeWorktreeStorageCoverage(environments)).toEqual({
      totalKnownBytes: 1_048_576,
      knownEnvironmentCount: 1,
      environmentCount: 3,
      loadingCount: 0,
      offlineCount: 1,
      unsupportedCount: 1,
      errorCount: 0,
      partialCount: 0,
      complete: false,
    });
    expect(
      planAcrossEnvironmentPrune(environments).targets.map((item) => item.environmentId),
    ).toEqual(["ready"]);
    expect(
      planAcrossEnvironmentPrune(environments).skipped.map((item) => item.environmentId),
    ).toEqual(["offline", "old"]);
    expect(worktreeStorageSkippedReason(environments[1]!)).toBe("offline");
    expect(worktreeStorageSkippedReason(environments[2]!)).toBe("unsupported");
    expect(
      computeWorktreeStorageCoverage([
        environment({
          environmentId: "partial" as EnvironmentId,
          label: "Partial",
          report: {
            totalBytes: 100,
            partial: true,
          } as MobileEnvironmentWorktreeStorageStatus["report"],
        }),
      ]),
    ).toMatchObject({
      totalKnownBytes: 100,
      knownEnvironmentCount: 1,
      partialCount: 1,
      complete: false,
    });
  });

  it("narrows confirmed prune scope when systems change before native confirmation runs", () => {
    const readyId = "ready" as EnvironmentId;
    const offlineId = "offline" as EnvironmentId;
    const disappearedId = "disappeared" as EnvironmentId;
    const newlyConnectedId = "new" as EnvironmentId;
    const result = reconcileConfirmedMobilePrunePlan(
      [
        environment({ environmentId: readyId, label: "Ready" }),
        environment({
          environmentId: offlineId,
          label: "Offline",
          connectionPhase: "offline",
          state: "offline",
        }),
        environment({ environmentId: newlyConnectedId, label: "New" }),
      ],
      [
        { environmentId: readyId, label: "Ready" },
        { environmentId: offlineId, label: "Offline" },
        { environmentId: disappearedId, label: "Disappeared" },
      ],
    );

    expect({
      targets: result.targets.map(({ environmentId, label }) => ({ environmentId, label })),
      skipped: result.skipped,
    }).toEqual({
      targets: [{ environmentId: readyId, label: "Ready" }],
      skipped: [
        { environmentId: offlineId, label: "Offline", reason: "offline" },
        { environmentId: disappearedId, label: "Disappeared", reason: "unavailable" },
      ],
    });
  });

  it("formats bounded details, protection reasons, and partial prune summaries", () => {
    expect(formatWorktreeStorageBytes(1_572_864)).toBe("1.5 MB");
    expect(worktreeDisplayName("/managed/repo/feature-a")).toBe("feature-a");
    expect(mobileProtectionLabel("active-turn-or-session")).toBe("active turn or session");
    expect(mobileProtectionLabel("unowned-or-orphaned")).toBe("no registered project");
    expect(
      summarizeMobilePrune(
        summarizePruneOutcomes([
          {
            environmentId: "ready",
            label: "Ready",
            status: "success",
            removedCount: 2,
            skippedCount: 3,
            failedCount: 1,
            freedBytes: 1_048_576,
            partial: true,
            serverErrorCount: 2,
            unreportedOutcomeCount: 5,
          },
          { environmentId: "offline", label: "Offline", status: "skipped", reason: "offline" },
          { environmentId: "failed", label: "Failed", status: "failure", error: "closed" },
        ]),
      ),
    ).toBe(
      "1 MB estimated reclaimed · 2 removed · 3 protected · 1 worktree failures · 1 partial systems · 2 server errors · 5 outcome details omitted · 1 systems skipped · 1 systems failed",
    );
  });
});
