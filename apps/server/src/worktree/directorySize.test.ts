// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  discoverWorktreeDirectoriesNoFollowPromise,
  measureDirectoryNoFollowPromise,
} from "./directorySize.ts";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".worktree-storage-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

describe("worktree directory sizing", () => {
  it("does not follow directory symlinks", async () => {
    const root = await makeTemporaryDirectory();
    const outside = await makeTemporaryDirectory();
    await NodeFSP.writeFile(NodePath.join(outside, "large.bin"), Buffer.alloc(1_000_000));
    await NodeFSP.symlink(outside, NodePath.join(root, "outside-link"), "dir");

    const result = await measureDirectoryNoFollowPromise(root, {
      maxEntries: 100,
      maxDurationMs: 5_000,
      maxFailures: 10,
    });

    expect(result.failures).toEqual([]);
    expect(result.bytes).toBeLessThan(1_000_000);
  });

  it("returns a partial failure instead of walking beyond the entry budget", async () => {
    const root = await makeTemporaryDirectory();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        NodeFSP.writeFile(NodePath.join(root, `entry-${index}`), "x"),
      ),
    );

    const result = await measureDirectoryNoFollowPromise(root, {
      maxEntries: 5,
      maxDurationMs: 5_000,
      maxFailures: 10,
    });

    expect(result.failures.map((failure) => failure.operation)).toContain("entry-budget");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("reports per-entry failures without rejecting the whole scan", async () => {
    const missing = NodePath.join(await makeTemporaryDirectory(), "missing");
    const result = await measureDirectoryNoFollowPromise(missing, {
      maxEntries: 10,
      maxDurationMs: 5_000,
      maxFailures: 10,
    });

    expect(result.bytes).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.operation).toBe("stat");
  });

  it("discovers managed worktree roots without descending through symlinks", async () => {
    const root = await makeTemporaryDirectory();
    const registered = NodePath.join(root, "repo", "branch");
    const outside = await makeTemporaryDirectory();
    await NodeFSP.mkdir(registered, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(registered, ".git"), "gitdir: elsewhere");
    await NodeFSP.writeFile(NodePath.join(outside, ".git"), "gitdir: elsewhere");
    await NodeFSP.symlink(outside, NodePath.join(root, "linked-outside"), "dir");

    const result = await discoverWorktreeDirectoriesNoFollowPromise(root, {
      maxEntries: 100,
      maxDurationMs: 5_000,
      maxFailures: 10,
    });

    expect(result.paths).toEqual([registered]);
    expect(result.failures).toEqual([]);
  });

  it("reports discovery lstat failures as stat operations", async () => {
    const missing = NodePath.join(await makeTemporaryDirectory(), "missing");
    const result = await discoverWorktreeDirectoriesNoFollowPromise(missing, {
      maxEntries: 10,
      maxDurationMs: 5_000,
      maxFailures: 10,
    });

    expect(result.paths).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.operation).toBe("stat");
  });

  const deadlineCases = [
    ["measurement", "lstat", measureDirectoryNoFollowPromise],
    ["measurement", "readdir", measureDirectoryNoFollowPromise],
    ["discovery", "lstat", discoverWorktreeDirectoriesNoFollowPromise],
    ["discovery", "readdir", discoverWorktreeDirectoriesNoFollowPromise],
  ] as const;

  it.each(deadlineCases)(
    "bounds a stalled %s %s operation by the time budget",
    async (_scanKind, stalledOperation, scan) => {
      vi.useFakeTimers();
      const never = new Promise<never>(() => undefined);
      const fileSystem = {
        lstat: () =>
          stalledOperation === "lstat"
            ? never
            : Promise.resolve({
                size: 1,
                isSymbolicLink: () => false,
                isDirectory: () => true,
              }),
        readdir: () => (stalledOperation === "readdir" ? never : Promise.resolve([])),
      };
      const resultPromise = scan(
        "/stalled",
        { maxEntries: 10, maxDurationMs: 100, maxFailures: 10 },
        fileSystem,
      );

      await vi.advanceTimersByTimeAsync(100);

      const result = await resultPromise;
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.operation).toBe("time-budget");
    },
  );
});
