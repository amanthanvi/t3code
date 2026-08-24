// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decodeWorktreePorcelain, worktreeRemovalArgs } from "./WorktreeStorage.ts";

const temporaryDirectories: string[] = [];

function git(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

describe("non-force worktree removal", () => {
  it("preserves dirty data in a temporary Git worktree", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".worktree-prune-git-test-"));
    temporaryDirectories.push(root);
    const repository = NodePath.join(root, "repository");
    const worktree = NodePath.join(root, "managed", "feature");
    await NodeFSP.mkdir(repository, { recursive: true });

    expect(git(repository, ["init", "-b", "main"]).status).toBe(0);
    expect(git(repository, ["config", "user.email", "test@example.com"]).status).toBe(0);
    expect(git(repository, ["config", "user.name", "T3 Test"]).status).toBe(0);
    await NodeFSP.writeFile(NodePath.join(repository, "tracked.txt"), "tracked\n");
    expect(git(repository, ["add", "tracked.txt"]).status).toBe(0);
    expect(git(repository, ["commit", "-m", "initial"]).status).toBe(0);
    expect(git(repository, ["worktree", "add", "-b", "feature", worktree]).status).toBe(0);
    await NodeFSP.writeFile(NodePath.join(worktree, "untracked.txt"), "keep me\n");

    const listing = git(repository, ["worktree", "list", "--porcelain", "-z"]);
    expect(listing.status).toBe(0);
    const decoded = decodeWorktreePorcelain(listing.stdout);
    expect("entries" in decoded).toBe(true);
    if ("error" in decoded) throw new Error(decoded.error);
    expect(decoded.entries.some((entry) => entry.path === worktree)).toBe(true);

    const removal = git(repository, worktreeRemovalArgs(worktree));
    expect(removal.status).not.toBe(0);
    expect(await NodeFSP.readFile(NodePath.join(worktree, "untracked.txt"), "utf8")).toBe(
      "keep me\n",
    );
  });
});
