// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
/**
 * Raw no-follow directory traversal isolated behind the worktree storage adapter.
 * Effect's portable FileSystem stat follows links, while this safety boundary needs lstat.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

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

interface DirectoryTraversalStats {
  readonly size: number;
  readonly isSymbolicLink: () => boolean;
  readonly isDirectory: () => boolean;
}

interface DirectoryTraversalFileSystem {
  readonly lstat: (path: string) => Promise<DirectoryTraversalStats>;
  readonly readdir: (path: string) => Promise<Array<string>>;
}

const deadlineExceeded = Symbol("deadlineExceeded");

async function runBeforeDeadline<A>(
  operation: () => Promise<A>,
  deadlineAtMs: number,
): Promise<A | typeof deadlineExceeded> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) return deadlineExceeded;

  let timeout: ReturnType<typeof NodeTimers.setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<typeof deadlineExceeded>((resolve) => {
        timeout = NodeTimers.setTimeout(() => resolve(deadlineExceeded), remainingMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) NodeTimers.clearTimeout(timeout);
  }
}

/** Measures directory entries without following symlinks and stops at explicit work budgets. */
export async function measureDirectoryNoFollowPromise(
  rootPath: string,
  options: DirectoryTraversalOptions,
  fileSystem: DirectoryTraversalFileSystem = NodeFSP,
): Promise<DirectorySizeScan> {
  const pending = [rootPath];
  const failures: DirectorySizeFailure[] = [];
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + options.maxDurationMs;
  let bytes = 0;
  let budgetReported = false;

  const reportBudget = (operation: "entry-budget" | "time-budget", cause: string) => {
    if (!budgetReported && failures.length < options.maxFailures) {
      failures.push({ operation, path: rootPath, cause });
      budgetReported = true;
    }
  };

  traversal: for (let index = 0; index < pending.length; index += 1) {
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
    let stats: DirectoryTraversalStats;
    try {
      const result = await runBeforeDeadline(() => fileSystem.lstat(current), deadlineAtMs);
      if (result === deadlineExceeded) {
        reportBudget(
          "time-budget",
          `Worktree scan exceeded ${options.maxDurationMs} milliseconds.`,
        );
        break;
      }
      stats = result;
    } catch (cause) {
      if (failures.length < options.maxFailures) {
        failures.push({ operation: "stat", path: current, cause });
      }
      continue;
    }

    bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + Math.max(0, stats.size));
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;

    try {
      const result = await runBeforeDeadline(() => fileSystem.readdir(current), deadlineAtMs);
      if (result === deadlineExceeded) {
        reportBudget(
          "time-budget",
          `Worktree scan exceeded ${options.maxDurationMs} milliseconds.`,
        );
        break traversal;
      }
      if (Date.now() >= deadlineAtMs) {
        reportBudget(
          "time-budget",
          `Worktree scan exceeded ${options.maxDurationMs} milliseconds.`,
        );
        break traversal;
      }
      const remaining = Math.max(0, options.maxEntries - pending.length);
      const selectedNames = result.slice(0, remaining);
      selectedNames.sort((left, right) => left.localeCompare(right));
      for (const name of selectedNames) {
        pending.push(NodePath.join(current, name));
      }
      if (result.length > remaining) {
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
  }

  return { bytes, failures };
}

/** Finds directory roots carrying a worktree `.git` entry without descending into them. */
export async function discoverWorktreeDirectoriesNoFollowPromise(
  rootPath: string,
  options: DirectoryTraversalOptions,
  fileSystem: DirectoryTraversalFileSystem = NodeFSP,
): Promise<WorktreeDirectoryDiscovery> {
  const pending = [rootPath];
  const paths: string[] = [];
  const failures: DirectorySizeFailure[] = [];
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + options.maxDurationMs;
  let budgetReported = false;

  const reportBudget = (operation: "entry-budget" | "time-budget", cause: string) => {
    if (!budgetReported && failures.length < options.maxFailures) {
      failures.push({ operation, path: rootPath, cause });
      budgetReported = true;
    }
  };

  traversal: for (let index = 0; index < pending.length; index += 1) {
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
    let stats: DirectoryTraversalStats;
    try {
      const result = await runBeforeDeadline(() => fileSystem.lstat(current), deadlineAtMs);
      if (result === deadlineExceeded) {
        reportBudget(
          "time-budget",
          `Worktree discovery exceeded ${options.maxDurationMs} milliseconds.`,
        );
        break;
      }
      stats = result;
    } catch (cause) {
      if (failures.length < options.maxFailures) {
        failures.push({ operation: "stat", path: current, cause });
      }
      continue;
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;

    try {
      const result = await runBeforeDeadline(() => fileSystem.readdir(current), deadlineAtMs);
      if (result === deadlineExceeded) {
        reportBudget(
          "time-budget",
          `Worktree discovery exceeded ${options.maxDurationMs} milliseconds.`,
        );
        break traversal;
      }
      if (Date.now() >= deadlineAtMs) {
        reportBudget(
          "time-budget",
          `Worktree discovery exceeded ${options.maxDurationMs} milliseconds.`,
        );
        break traversal;
      }
      if (current !== rootPath && result.includes(".git")) {
        paths.push(current);
        continue;
      }
      const remaining = Math.max(0, options.maxEntries - pending.length);
      const selectedNames = result.slice(0, remaining);
      selectedNames.sort((left, right) => left.localeCompare(right));
      for (const name of selectedNames) {
        pending.push(NodePath.join(current, name));
      }
      if (result.length > remaining) {
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
