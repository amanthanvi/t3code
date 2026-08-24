import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { WsWorktreeStoragePruneStaleRpc } from "./rpc.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
import {
  DEFAULT_WORKTREE_AUTO_PRUNE_POLICY,
  WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS,
  WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS,
  WORKTREE_STORAGE_MAX_ASSOCIATED_THREAD_IDS,
  WORKTREE_STORAGE_MAX_DETAILS,
  WORKTREE_STORAGE_MAX_ERRORS,
  WORKTREE_STORAGE_MAX_OUTCOMES,
  WORKTREE_STORAGE_MAX_PROJECTS,
  WorktreeAutoPrunePolicy,
  WorktreeStorageError,
  WorktreeStoragePruneResult,
  WorktreeStorageReport,
} from "./worktreeStorage.ts";

const decodePolicy = Schema.decodeUnknownSync(WorktreeAutoPrunePolicy);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeReport = Schema.decodeUnknownSync(WorktreeStorageReport);
const decodePruneResult = Schema.decodeUnknownSync(WorktreeStoragePruneResult);
const decodePruneRequest = Schema.decodeUnknownSync(WsWorktreeStoragePruneStaleRpc.payloadSchema);

describe("worktree storage contracts", () => {
  it("defaults automatic pruning off for legacy settings", () => {
    expect(decodeSettings({}).worktreeAutoPrunePolicy).toEqual(DEFAULT_WORKTREE_AUTO_PRUNE_POLICY);
  });

  it("derives stable worktree storage failure text from a structured reason", () => {
    const error = new WorktreeStorageError({
      operation: "report",
      reason: "state-load-failed",
      cause: new Error("internal detail"),
    });

    expect(error.reason).toBe("state-load-failed");
    expect(error.message).toBe("Worktree storage report could not load current environment state.");
  });

  it("accepts only bounded whole-day inactivity policies", () => {
    for (const inactivityDays of [
      WORKTREE_AUTO_PRUNE_MIN_INACTIVITY_DAYS,
      WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS,
    ]) {
      expect(decodePolicy({ mode: "after-inactive-days", inactivityDays })).toEqual({
        mode: "after-inactive-days",
        inactivityDays,
      });
    }
    for (const inactivityDays of [0, 1.5, WORKTREE_AUTO_PRUNE_MAX_INACTIVITY_DAYS + 1]) {
      expect(() => decodePolicy({ mode: "after-inactive-days", inactivityDays })).toThrow();
      expect(() =>
        decodeSettingsPatch({
          worktreeAutoPrunePolicy: { mode: "after-inactive-days", inactivityDays },
        }),
      ).toThrow();
    }
  });

  it("caps report arrays and associated thread identifiers", () => {
    const detail = {
      projectId: ProjectId.make("project-1"),
      projectTitle: "Project",
      worktreePath: "/tmp/worktree",
      bytes: 1,
      associatedThreadCount: 1,
      associatedThreadIds: [ThreadId.make("thread-1")],
      latestActivityAt: null,
      stale: true,
      eligible: true,
      protectionReasons: [],
      scanErrors: [],
    } as const;
    const report = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      totalBytes: 1,
      worktreeCount: 1,
      staleWorktreeCount: 1,
      eligibleWorktreeCount: 1,
      projects: [],
      projectCount: 0,
      details: [detail],
      detailCount: 1,
      errors: [],
      partial: false,
    } as const;

    expect(() =>
      decodeReport({
        ...report,
        projects: Array.from({ length: WORKTREE_STORAGE_MAX_PROJECTS + 1 }, () => ({
          projectId: ProjectId.make("project-1"),
          projectTitle: "Project",
          bytes: 1,
          worktreeCount: 1,
          staleWorktreeCount: 1,
          eligibleWorktreeCount: 1,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeReport({
        ...report,
        details: Array.from({ length: WORKTREE_STORAGE_MAX_DETAILS + 1 }, () => detail),
      }),
    ).toThrow();
    expect(() =>
      decodeReport({
        ...report,
        details: [
          {
            ...detail,
            associatedThreadIds: Array.from(
              { length: WORKTREE_STORAGE_MAX_ASSOCIATED_THREAD_IDS + 1 },
              () => ThreadId.make("thread-1"),
            ),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeReport({
        ...report,
        errors: Array.from({ length: WORKTREE_STORAGE_MAX_ERRORS + 1 }, () => ({
          operation: "scan",
          message: "failed",
        })),
      }),
    ).toThrow();
  });

  it("caps prune outcomes and keeps the prune payload path-free", () => {
    const outcome = {
      worktreePath: "/tmp/worktree",
      projectId: ProjectId.make("project-1"),
      bytes: 1,
      status: "removed" as const,
      protectionReasons: [],
    };
    expect(() =>
      decodePruneResult({
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        removedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        reclaimedBytes: 1,
        outcomes: Array.from({ length: WORKTREE_STORAGE_MAX_OUTCOMES + 1 }, () => outcome),
        outcomeCount: WORKTREE_STORAGE_MAX_OUTCOMES + 1,
        errors: [],
        partial: true,
      }),
    ).toThrow();

    expect(() =>
      decodePruneRequest({
        worktreePath: "/tmp/user-controlled",
      }),
    ).toThrow();
    expect(() => decodePruneRequest([])).toThrow();
  });
});
