// @effect-diagnostics nodeBuiltinImport:off - Verifies the reservation with real native processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { startDesktopHandoff } from "./desktopHandoff.ts";
import { acquireDesktopSupervisor } from "./desktopOwnership.ts";

const workerUrl = new URL("./desktopHandoff.ts", import.meta.url).href;
const ownershipUrl = new URL("./desktopOwnership.ts", import.meta.url).href;

it.live(
  "retains the desktop gate through the old-parent exit gap and a replacement ownership ACK",
  () =>
    Effect.promise(async () => {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-handoff-"));
      const lockPath = NodePath.join(baseDir, "userdata", "server-owner.sqlite");
      const oldParent = acquireDesktopSupervisor(NodePath.join(baseDir, "userdata"));
      const attemptLegacy = () =>
        NodeChildProcess.spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(${JSON.stringify(lockPath)});
        try { db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;'); }
        catch (error) { process.exitCode = error.errcode === 5 ? 78 : 1; }
        finally { db.close(); }
      `,
          ],
          { stdio: "ignore" },
        ).status;
      let helper: Awaited<ReturnType<typeof startDesktopHandoff>> | undefined;
      let replacement: NodeChildProcess.ChildProcess | undefined;
      let exited: Promise<void> | undefined;
      try {
        helper = await startDesktopHandoff({
          executablePath: process.execPath,
          args: [
            new URL("../../../apps/server/src/bin.ts", import.meta.url).pathname,
            "__desktop-handoff",
          ],
          cwd: process.cwd(),
          env: process.env,
          stateDir: NodePath.join(baseDir, "userdata"),
        });
        oldParent.close();
        assert.equal(attemptLegacy(), 78);
        replacement = NodeChildProcess.spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { acquireDesktopSupervisor } from ${JSON.stringify(ownershipUrl)};
        import { acknowledgeDesktopHandoff } from ${JSON.stringify(workerUrl)};
        const parent = acquireDesktopSupervisor(${JSON.stringify(NodePath.join(baseDir, "userdata"))});
        await acknowledgeDesktopHandoff(${JSON.stringify(NodePath.join(baseDir, "userdata"))});
        process.on('message', () => {});
        process.send('ready');
      `,
          ],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        );
        exited = new Promise<void>((resolve) => replacement!.once("exit", () => resolve()));
        await new Promise<void>((resolve, reject) => {
          replacement!.once("message", () => resolve());
          replacement!.once("error", reject);
          replacement!.once("exit", () =>
            reject(new Error("Replacement did not acquire ownership.")),
          );
        });
        await helper.cancel();
        helper = undefined;
        assert.equal(attemptLegacy(), 78);
        replacement.kill();
        await exited;
        replacement = undefined;
        assert.equal(attemptLegacy(), 0);
      } finally {
        oldParent.close();
        if (replacement?.exitCode === null && replacement.signalCode === null) replacement.kill();
        await exited;
        await helper?.cancel();
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
);

it.live("cancels a prepared restart while the old desktop continues owning the home", () =>
  Effect.promise(async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-cancel-"));
    const oldParent = acquireDesktopSupervisor(NodePath.join(baseDir, "userdata"));
    try {
      await expect(
        startDesktopHandoff({
          executablePath: NodePath.join(baseDir, "missing-runtime"),
          args: [],
          cwd: baseDir,
          env: process.env,
          stateDir: NodePath.join(baseDir, "userdata"),
        }),
      ).rejects.toThrow();
      const helper = await startDesktopHandoff({
        executablePath: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `import { runDesktopHandoff } from ${JSON.stringify(workerUrl)}; await runDesktopHandoff();`,
        ],
        cwd: process.cwd(),
        env: process.env,
        stateDir: NodePath.join(baseDir, "userdata"),
      });
      await helper.assertAlive();
      await helper.cancel();
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(baseDir, "userdata", ".desktop-handoff.json")),
      );
    } finally {
      oldParent.close();
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);
