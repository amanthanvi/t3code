// @effect-diagnostics nodeBuiltinImport:off - Verifies local IPC and native leases with real subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { acknowledgeServiceHandoff, prepareServiceHandoff } from "./serviceHandoff.ts";

const runChild = async (source: string) => {
  const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Handoff fixture exited before ready")));
    });
  } catch (cause) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    throw cause;
  }
  return async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  };
};

it.live("reserves replacement until the new launcher acknowledges its own native leases", () =>
  Effect.promise(async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-handoff-test-"));
    const gatePath = NodePath.join(baseDir, "userdata", "server-owner.sqlite");
    const helperUrl = new URL("../serverOwnershipLock.ts", import.meta.url).href;
    const handoffUrl = new URL("./serviceHandoff.ts", import.meta.url).href;
    const attemptLegacy = () =>
      NodeChildProcess.spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(${JSON.stringify(gatePath)});
       try { db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;'); }
       catch (error) { process.exitCode = error.errcode === 5 ? 78 : 1; }
       finally { db.close(); }`,
      ]).status;
    let handoff: Awaited<ReturnType<typeof prepareServiceHandoff>> | undefined;
    let stopChild: (() => Promise<void>) | undefined;
    try {
      handoff = await prepareServiceHandoff(baseDir);
      await expect(prepareServiceHandoff(baseDir)).rejects.toThrow();
      assert.equal(attemptLegacy(), 78);
      stopChild = await runChild(`
        import { acquireOwnershipLock } from ${JSON.stringify(helperUrl)};
        import { acknowledgeServiceHandoff } from ${JSON.stringify(handoffUrl)};
        const gate = acquireOwnershipLock(${JSON.stringify(gatePath)}, 'shared');
        const control = acquireOwnershipLock(${JSON.stringify(NodePath.join(baseDir, "userdata", "service-launcher-owner.sqlite"))}, 'exclusive');
        await acknowledgeServiceHandoff(${JSON.stringify(baseDir)});
        process.on('message', () => {});
        process.send({ ready: true });
      `);
      await handoff.waitForReady(120_000);
      await handoff.close();
      assert.equal(attemptLegacy(), 78);
      await stopChild();
      stopChild = undefined;
      assert.equal(attemptLegacy(), 0);
    } finally {
      await stopChild?.();
      await handoff?.close();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.live("clears a stale marker only when the installer's exclusive lease is free", () =>
  Effect.promise(async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-handoff-stale-"));
    const markerPath = NodePath.join(baseDir, "runtime", ".service-handoff.json");
    const handoff = await prepareServiceHandoff(baseDir);
    const original = NodeFS.readFileSync(markerPath, "utf8");
    const marker = JSON.parse(original) as { nonce: string; socketPath: string };
    try {
      NodeFS.writeFileSync(
        markerPath,
        JSON.stringify({
          ...marker,
          socketPath: NodePath.join(
            NodePath.dirname(NodePath.dirname(marker.socketPath)),
            `t3-handoff-gone-${marker.nonce.slice(0, 8)}`,
            "ready.sock",
          ),
        }),
      );
      await expect(acknowledgeServiceHandoff(baseDir)).rejects.toThrow();
      assert.isTrue(NodeFS.existsSync(markerPath));
      NodeFS.writeFileSync(markerPath, original);
      await handoff.close();
      NodeFS.writeFileSync(markerPath, original, { mode: 0o600 });
      await acknowledgeServiceHandoff(baseDir);
      assert.isFalse(NodeFS.existsSync(markerPath));
    } finally {
      await handoff.close();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.live("refuses before stopping a live exclusive legacy owner", () =>
  Effect.promise(async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-handoff-legacy-"));
    const gatePath = NodePath.join(baseDir, "userdata", "server-owner.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(gatePath), { recursive: true });
    const stop = await runChild(`import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(gatePath)});
      db.exec('BEGIN EXCLUSIVE;');
      process.on('message', () => {});
      process.send({ ready: true });`);
    try {
      await expect(prepareServiceHandoff(baseDir)).rejects.toThrow(
        /coordinated ownership migration/,
      );
    } finally {
      await stop();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.live("rejects a corrupt active marker but removes it after its installer exits", () =>
  Effect.promise(async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-handoff-corrupt-"));
    const markerPath = NodePath.join(baseDir, "runtime", ".service-handoff.json");
    const handoff = await prepareServiceHandoff(baseDir);
    try {
      NodeFS.writeFileSync(markerPath, "{");
      await expect(acknowledgeServiceHandoff(baseDir)).rejects.toThrow();
      assert.isTrue(NodeFS.existsSync(markerPath));
      await handoff.close();
      await acknowledgeServiceHandoff(baseDir);
      assert.isFalse(NodeFS.existsSync(markerPath));
    } finally {
      await handoff.close();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);
