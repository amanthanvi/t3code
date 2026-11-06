// @effect-diagnostics nodeBuiltinImport:off - Native ownership must be tested across actual process boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { acquireDesktopSupervisor, desktopOwnershipResponse } from "./desktopOwnership.ts";
import {
  SERVER_OWNER_FILE,
  SERVER_WRITER_FILE,
  DESKTOP_SUPERVISOR_OWNER_FILE,
} from "./serverOwnershipLock.ts";

const ownershipUrl = new URL("./desktopOwnership.ts", import.meta.url).href;
const lockUrl = new URL("./serverOwnershipLock.ts", import.meta.url).href;
const nonce = "a".repeat(64);

function attemptExclusive(lockPath: string) {
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { acquireOwnershipLock } from ${JSON.stringify(lockUrl)};
    try { acquireOwnershipLock(${JSON.stringify(lockPath)}, 'exclusive').db.close(); }
    catch (cause) { process.exitCode = cause.errcode === 5 ? 78 : 1; }
  `,
    ],
    { stdio: "ignore" },
  );
  assert.isUndefined(child.error);
  return child.status;
}

function startWriter(baseDir: string, mode: "shared" | "exclusive", desktopController = false) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { acquireOwnershipLock } from ${JSON.stringify(lockUrl)};
    const gate = acquireOwnershipLock(${JSON.stringify(NodePath.join(baseDir, "userdata", SERVER_OWNER_FILE))}, ${JSON.stringify(mode)});
    const controller = ${desktopController} ? acquireOwnershipLock(${JSON.stringify(NodePath.join(baseDir, "userdata", DESKTOP_SUPERVISOR_OWNER_FILE))}, 'exclusive') : undefined;
    const writer = acquireOwnershipLock(${JSON.stringify(NodePath.join(baseDir, "userdata", SERVER_WRITER_FILE))}, 'exclusive');
    process.once('message', () => { writer.db.close(); gate.db.close(); controller?.db.close(); process.disconnect(); });
    process.send('ready');
  `,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Writer exited before readiness.")));
  });
  return {
    ready,
    async close() {
      if (child.connected) child.send("stop");
      await exited;
    },
  };
}

it.live(
  "blocks legacy SSH owners through a zero-writer gap and releases explicit desktop shutdown",
  () =>
    Effect.promise(async () => {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-owner-"));
      const ownerPath = NodePath.join(baseDir, "userdata", SERVER_OWNER_FILE);
      const writerPath = NodePath.join(baseDir, "userdata", SERVER_WRITER_FILE);
      let supervisor: ReturnType<typeof acquireDesktopSupervisor> | undefined;
      let writer: ReturnType<typeof startWriter> | undefined;
      try {
        writer = startWriter(baseDir, "exclusive");
        await writer.ready;
        await writer.close();
        writer = undefined;
        // The old desktop leaves no holder after stopping its sole backend.
        assert.equal(attemptExclusive(ownerPath), 0);

        supervisor = acquireDesktopSupervisor(NodePath.join(baseDir, "userdata"));
        assert.throws(() => acquireDesktopSupervisor(NodePath.join(baseDir, "userdata")));
        assert.equal(
          attemptExclusive(NodePath.join(baseDir, "userdata", DESKTOP_SUPERVISOR_OWNER_FILE)),
          78,
        );
        const before = NodeFS.statSync(ownerPath, { bigint: true });
        writer = startWriter(baseDir, "shared");
        await writer.ready;
        await writer.close();
        writer = undefined;
        assert.equal(attemptExclusive(writerPath), 0);
        assert.equal(attemptExclusive(ownerPath), 78);
        writer = startWriter(baseDir, "shared");
        await writer.ready;
        await writer.close();
        writer = undefined;
        assert.equal(attemptExclusive(writerPath), 0);
        assert.equal(attemptExclusive(ownerPath), 78);
        const after = NodeFS.statSync(ownerPath, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.dev, before.dev);
        supervisor.close();
        supervisor = undefined;
        assert.equal(attemptExclusive(ownerPath), 0);
        writer = startWriter(baseDir, "shared", true);
        await writer.ready;
        assert.throws(() => acquireDesktopSupervisor(NodePath.join(baseDir, "userdata")));
        await writer.close();
        writer = undefined;
        const replacement = acquireDesktopSupervisor(NodePath.join(baseDir, "userdata"));
        replacement.close();
      } finally {
        await writer?.close();
        supervisor?.close();
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
);

it.live(
  "authenticates a live inherited desktop channel and rejects forged, missing and disconnected channels",
  () =>
    Effect.promise(async () => {
      for (const scenario of ["valid", "forged", "missing", "disconnected"] as const) {
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { authenticateDesktopSupervisor } from ${JSON.stringify(ownershipUrl)};
        try {
          const connection = await authenticateDesktopSupervisor({ fd: 8, nonce: ${JSON.stringify(nonce)} });
          process.send('authenticated');
          await connection.lost;
          process.send(connection.connected() ? 'still-connected' : 'lost');
        } catch { process.send('rejected'); }
        process.disconnect();
      `,
          ],
          {
            stdio: [
              "ignore",
              "ignore",
              "ignore",
              "ipc",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              scenario === "missing" ? "ignore" : "pipe",
            ],
          },
        );
        const messages: unknown[] = [];
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", () => resolve());
        });
        child.on("message", (message) => {
          messages.push(message);
          if (message === "authenticated") child.stdio.at(8)?.destroy();
        });
        const channel = child.stdio.at(8);
        if (channel instanceof NodeStream.Duplex) {
          let received = "";
          channel.on("error", () => {});
          channel.on("data", (chunk) => {
            received += String(chunk);
            if (!received.endsWith("\n")) return;
            if (scenario === "disconnected") channel.destroy();
            else if (scenario === "forged") channel.write(`owned:${nonce}:${"b".repeat(64)}\n`);
            else channel.write(desktopOwnershipResponse(received.trimEnd(), nonce));
          });
        }
        await exited;
        assert.equal(child.exitCode, 0);
        assert.deepEqual(messages, scenario === "valid" ? ["authenticated", "lost"] : ["rejected"]);
      }
    }),
);
