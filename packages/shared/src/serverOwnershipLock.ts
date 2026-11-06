// @effect-diagnostics nodeBuiltinImport:off - Native ownership leases are shared by the desktop and server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export const SERVER_OWNER_FILE = "server-owner.sqlite";
export const SERVER_WRITER_FILE = "server-writer.sqlite";
export const DESKTOP_SUPERVISOR_OWNER_FILE = "desktop-supervisor-owner.sqlite";
export const DESKTOP_HANDOFF_OWNER_FILE = "desktop-handoff-owner.sqlite";

const heldInodes = new Set<string>();

/** Never unlink these files: process exit releases their native SQLite leases. */
export function acquireOwnershipLock(lockPath: string, mode: "exclusive" | "shared") {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  let before = NodeFS.statSync(lockPath, { bigint: true, throwIfNoEntry: false });
  if (before === undefined) {
    NodeFS.closeSync(NodeFS.openSync(lockPath, "a", 0o644));
    before = NodeFS.statSync(lockPath, { bigint: true });
  }
  const inode = `${before.dev}:${before.ino}`;
  // Closing a second descriptor for this inode would release our existing POSIX locks.
  if (heldInodes.has(inode)) {
    throw Object.assign(new Error("Ownership lock already held in this process"), {
      code: "SQLITE_BUSY",
      errcode: 5,
    });
  }
  const db = new NodeSqlite.DatabaseSync(lockPath);
  try {
    // A deferred BEGIN alone does not take SHARED, including on a zero-byte lockfile.
    db.exec(
      mode === "shared"
        ? "PRAGMA busy_timeout = 0; BEGIN; SELECT * FROM sqlite_schema;"
        : "PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;",
    );
    const identity = NodeFS.statSync(lockPath, { bigint: true });
    heldInodes.add(inode);
    const close = db.close.bind(db);
    let closed = false;
    db.close = () => {
      if (closed) return;
      close();
      closed = true;
      heldInodes.delete(inode);
    };
    return {
      db,
      identity,
      lockPath,
      replacedDuringAcquire: before.dev !== identity.dev || before.ino !== identity.ino,
    };
  } catch (cause) {
    db.close();
    throw cause;
  }
}
