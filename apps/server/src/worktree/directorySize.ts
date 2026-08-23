// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * Raw no-follow directory traversal isolated behind the worktree storage adapter.
 * Effect's portable FileSystem stat follows links, while this safety boundary needs lstat.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface DirectorySizeFailure {
  readonly operation: "entry-budget" | "time-budget" | "read-directory" | "stat";
  readonly path: string;
  readonly cause: unknown;
}

export interface DirectorySizeScan {
  readonly bytes: number;
  readonly failures: ReadonlyArray<DirectorySizeFailure>;
}

export interface DirectoryTraversalOptions {
  readonly maxEntries: number;
  readonly maxDurationMs: number;
  readonly maxFailures: number;
}

export interface WorktreeDirectoryDiscovery {
  readonly paths: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<DirectorySizeFailure>;
}

/** Measures directory entries without following symlinks and stops at explicit work budgets. */
export async function measureDirectoryNoFollowPromise(
  rootPath: string,
  options: DirectoryTraversalOptions,
): Promise<DirectorySizeScan> {
  const pending = [rootPath];
  const failures: DirectorySizeFailure[] = [];
  const startedAtMs = Date.now();
  let bytes = 0;
  let budgetReported = false;

  const reportBudget = (operation: "entry-budget" | "time-budget", cause: string) => {
    if (!budgetReported && failures.length < options.maxFailures) {
      failures.push({ operation, path: rootPath, cause });
      budgetReported = true;
    }
  };

  for (let index = 0; index < pending.length; index += 1) {
    if (index >= options.maxEntries) {
      reportBudget(
        "entry-budget",
        `Worktree scan exceeded ${options.maxEntries} filesystem entries.`,
      );
      break;
    }
    if (Date.now() - startedAtMs >= options.maxDurationMs) {
      reportBudget("time-budget", `Worktree scan exceeded ${options.maxDurationMs} milliseconds.`);
      break;
    }

    const current = pending[index];
    if (current === undefined) continue;
    try {
      const stats = await NodeFSP.lstat(current);
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + Math.max(0, stats.size));
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;

      try {
        const names = await NodeFSP.readdir(current);
        names.sort((left, right) => left.localeCompare(right));
        const remaining = Math.max(0, options.maxEntries - pending.length);
        for (const name of names.slice(0, remaining)) {
          pending.push(NodePath.join(current, name));
        }
        if (names.length > remaining) {
          reportBudget(
            "entry-budget",
            `Worktree scan exceeded ${options.maxEntries} filesystem entries.`,
          );
        }
      } catch (cause) {
        if (failures.length < options.maxFailures) {
          failures.push({ operation: "read-directory", path: current, cause });
        }
      }
    } catch (cause) {
      if (failures.length < options.maxFailures) {
        failures.push({ operation: "stat", path: current, cause });
      }
    }
  }

  return { bytes, failures };
}

/** Finds directory roots carrying a worktree `.git` entry without descending into them. */
export async function discoverWorktreeDirectoriesNoFollowPromise(
  rootPath: string,
  options: DirectoryTraversalOptions,
): Promise<WorktreeDirectoryDiscovery> {
  const pending = [rootPath];
  const paths: string[] = [];
  const failures: DirectorySizeFailure[] = [];
  const startedAtMs = Date.now();
  let budgetReported = false;

  const reportBudget = (operation: "entry-budget" | "time-budget", cause: string) => {
    if (!budgetReported && failures.length < options.maxFailures) {
      failures.push({ operation, path: rootPath, cause });
      budgetReported = true;
    }
  };

  for (let index = 0; index < pending.length; index += 1) {
    if (index >= options.maxEntries) {
      reportBudget(
        "entry-budget",
        `Worktree discovery exceeded ${options.maxEntries} filesystem entries.`,
      );
      break;
    }
    if (Date.now() - startedAtMs >= options.maxDurationMs) {
      reportBudget(
        "time-budget",
        `Worktree discovery exceeded ${options.maxDurationMs} milliseconds.`,
      );
      break;
    }

    const current = pending[index];
    if (current === undefined) continue;
    try {
      const stats = await NodeFSP.lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      const names = await NodeFSP.readdir(current);
      names.sort((left, right) => left.localeCompare(right));
      if (current !== rootPath && names.includes(".git")) {
        paths.push(current);
        continue;
      }
      const remaining = Math.max(0, options.maxEntries - pending.length);
      for (const name of names.slice(0, remaining)) {
        pending.push(NodePath.join(current, name));
      }
      if (names.length > remaining) {
        reportBudget(
          "entry-budget",
          `Worktree discovery exceeded ${options.maxEntries} filesystem entries.`,
        );
      }
    } catch (cause) {
      if (failures.length < options.maxFailures) {
        failures.push({ operation: "read-directory", path: current, cause });
      }
    }
  }

  return { paths, failures };
}
