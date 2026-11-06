// @effect-diagnostics nodeBuiltinImport:off - Exercises native leases across real process crashes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  acquireOwnershipLock,
  SERVER_OWNER_FILE,
  SERVER_WRITER_FILE,
  SERVICE_LAUNCHER_OWNER_FILE,
} from "./serverOwnershipLock.ts";

it.live("retains a writer's native leases when its controller crashes", () =>
  Effect.promise(async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lease-"));
    const ownerPath = NodePath.join(root, SERVER_OWNER_FILE);
    const writerPath = NodePath.join(root, SERVER_WRITER_FILE);
    const controlPath = NodePath.join(root, SERVICE_LAUNCHER_OWNER_FILE);
    const helperUrl = new URL("./serverOwnershipLock.ts", import.meta.url).href;
    NodeFS.writeFileSync(ownerPath, "");
    const before = NodeFS.statSync(ownerPath, { bigint: true });
    const spawned: Array<{
      readonly process: NodeChildProcess.ChildProcess;
      readonly ready: Promise<void>;
      readonly exited: Promise<void>;
    }> = [];
    const start = (leasePath: string) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import { acquireOwnershipLock } from ${JSON.stringify(helperUrl)};
          const gate = acquireOwnershipLock(${JSON.stringify(ownerPath)}, 'shared');
          const lease = acquireOwnershipLock(${JSON.stringify(leasePath)}, 'exclusive');
          process.on('message', () => process.send({ alive: true }));
          process.send({ ready: true });
        `,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Native lease fixture exited before ready")));
      });
      const actor = { process: child, ready, exited };
      spawned.push(actor);
      return actor;
    };
    const held: Array<ReturnType<typeof acquireOwnershipLock>> = [];
    try {
      const controller = start(controlPath);
      await controller.ready;
      const writer = start(writerPath);
      await writer.ready;
      assert.throws(() => acquireOwnershipLock(controlPath, "exclusive"), /locked/);
      assert.throws(() => acquireOwnershipLock(writerPath, "exclusive"), /locked/);
      controller.process.kill("SIGKILL");
      await controller.exited;
      held.push(acquireOwnershipLock(controlPath, "exclusive"));
      held.push(acquireOwnershipLock(ownerPath, "shared"));
      assert.throws(() => acquireOwnershipLock(writerPath, "exclusive"), /locked/);
      const alive = new Promise<unknown>((resolve) => writer.process.once("message", resolve));
      writer.process.send({ ping: true });
      assert.deepEqual(await alive, { alive: true });
      writer.process.kill("SIGKILL");
      await writer.exited;
      held.push(acquireOwnershipLock(writerPath, "exclusive"));
      const after = NodeFS.statSync(ownerPath, { bigint: true });
      assert.equal(after.ino, before.ino);
      assert.equal(after.dev, before.dev);
      assert.equal(after.size, 0n);
      for (const lock of held.reverse()) lock.db.close();
      held.length = 0;
      for (const file of [ownerPath, writerPath, controlPath]) {
        const lock = acquireOwnershipLock(file, "exclusive");
        lock.db.close();
      }
    } finally {
      for (const lock of held.reverse()) lock.db.close();
      for (const actor of spawned) {
        if (actor.process.exitCode === null && actor.process.signalCode === null) {
          actor.process.kill("SIGKILL");
        }
        await actor.exited;
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);
