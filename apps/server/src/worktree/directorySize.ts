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
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly isSymbolicLink: () => boolean;
  readonly isDirectory: () => boolean;
}

interface DirectoryTraversalFileSystem {
  readonly lstat: (path: string) => Promise<DirectoryTraversalStats>;
  readonly readdir: (path: string) => Promise<Array<string>>;
}

const deadlineExceeded = Symbol("deadlineExceeded");

type ValidatedDirectoryRead =
  | { readonly _tag: "Success"; readonly entries: ReadonlyArray<string> }
  | { readonly _tag: "DeadlineExceeded" }
  | {
      readonly _tag: "Failure";
      readonly operation: "read-directory" | "stat";
      readonly cause: unknown;
    };

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

async function readValidatedDirectory(
  fileSystem: DirectoryTraversalFileSystem,
  current: string,
  expected: DirectoryTraversalStats,
  deadlineAtMs: number,
): Promise<ValidatedDirectoryRead> {
  let entries: ReadonlyArray<string>;
  try {
    const result = await runBeforeDeadline(() => fileSystem.readdir(current), deadlineAtMs);
    if (result === deadlineExceeded || Date.now() >= deadlineAtMs) {
      return { _tag: "DeadlineExceeded" };
    }
    entries = result;
  } catch (cause) {
    return { _tag: "Failure", operation: "read-directory", cause };
  }

  try {
    const result = await runBeforeDeadline(() => fileSystem.lstat(current), deadlineAtMs);
    if (result === deadlineExceeded || Date.now() >= deadlineAtMs) {
      return { _tag: "DeadlineExceeded" };
    }
    if (
      result.isSymbolicLink() ||
      !result.isDirectory() ||
      result.dev !== expected.dev ||
      result.ino !== expected.ino
    ) {
      return {
        _tag: "Failure",
        operation: "stat",
        cause: new Error("Directory identity changed while it was being read."),
      };
    }
  } catch (cause) {
    return { _tag: "Failure", operation: "stat", cause };
  }

  return { _tag: "Success", entries };
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
      if (Date.now() >= deadlineAtMs) {
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

    const directoryRead = await readValidatedDirectory(fileSystem, current, stats, deadlineAtMs);
    if (directoryRead._tag === "DeadlineExceeded") {
      reportBudget("time-budget", `Worktree scan exceeded ${options.maxDurationMs} milliseconds.`);
      break traversal;
    }
    if (directoryRead._tag === "Failure") {
      if (failures.length < options.maxFailures) {
        failures.push({
          operation: directoryRead.operation,
          path: current,
          cause: directoryRead.cause,
        });
      }
      continue;
    }
    const remaining = Math.max(0, options.maxEntries - pending.length);
    const selectedNames = directoryRead.entries.slice(0, remaining);
    selectedNames.sort((left, right) => left.localeCompare(right));
    for (const name of selectedNames) {
      pending.push(NodePath.join(current, name));
    }
    if (directoryRead.entries.length > remaining) {
      reportBudget(
        "entry-budget",
        `Worktree scan exceeded ${options.maxEntries} filesystem entries.`,
      );
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
      if (Date.now() >= deadlineAtMs) {
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

    const directoryRead = await readValidatedDirectory(fileSystem, current, stats, deadlineAtMs);
    if (directoryRead._tag === "DeadlineExceeded") {
      reportBudget(
        "time-budget",
        `Worktree discovery exceeded ${options.maxDurationMs} milliseconds.`,
      );
      break traversal;
    }
    if (directoryRead._tag === "Failure") {
      if (failures.length < options.maxFailures) {
        failures.push({
          operation: directoryRead.operation,
          path: current,
          cause: directoryRead.cause,
        });
      }
      continue;
    }
    if (current !== rootPath && directoryRead.entries.includes(".git")) {
      paths.push(current);
      continue;
    }
    const remaining = Math.max(0, options.maxEntries - pending.length);
    const selectedNames = directoryRead.entries.slice(0, remaining);
    selectedNames.sort((left, right) => left.localeCompare(right));
    for (const name of selectedNames) {
      pending.push(NodePath.join(current, name));
    }
    if (directoryRead.entries.length > remaining) {
      reportBudget(
        "entry-budget",
        `Worktree discovery exceeded ${options.maxEntries} filesystem entries.`,
      );
    }
  }

  return { paths, failures };
}
