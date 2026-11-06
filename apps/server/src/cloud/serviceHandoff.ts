// @effect-diagnostics nodeBuiltinImport:off - The installer and standalone launcher share this native handshake.
// @effect-diagnostics globalTimers:off - The standalone launcher cannot depend on an Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  acquireOwnershipLock,
  SERVER_OWNER_FILE,
  SERVICE_INSTALLER_OWNER_FILE,
} from "../serverOwnershipLock.ts";

const MARKER_FILE = ".service-handoff.json";
const SOCKET_DIRECTORY_PREFIX = "t3-handoff-";
const markerPath = (baseDir: string) => NodePath.join(baseDir, "runtime", MARKER_FILE);
const installerLockPath = (baseDir: string) =>
  NodePath.join(baseDir, "runtime", SERVICE_INSTALLER_OWNER_FILE);
export const acquireServiceInstallerLease = (
  baseDir: string,
  mode: "exclusive" | "shared" = "exclusive",
) => acquireOwnershipLock(installerLockPath(baseDir), mode);
const isBusy = (cause: unknown) =>
  cause instanceof Error && "errcode" in cause && cause.errcode === 5;
const isMissingEndpoint = (cause: unknown) =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ECONNREFUSED");

interface Marker {
  readonly nonce: string;
  readonly socketPath: string;
}

function safeMarkerStat(baseDir: string) {
  const stat = NodeFS.lstatSync(markerPath(baseDir), { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error("Service handoff marker has unsafe ownership or permissions.");
  }
  return stat;
}

function removeAbandonedMarker(baseDir: string): boolean {
  const before = safeMarkerStat(baseDir);
  if (before === undefined) return true;
  let installer: ReturnType<typeof acquireOwnershipLock>;
  try {
    installer = acquireServiceInstallerLease(baseDir);
  } catch (cause) {
    if (isBusy(cause)) return false;
    throw cause;
  }
  try {
    const current = safeMarkerStat(baseDir);
    if (current?.dev === before.dev && current.ino === before.ino) {
      NodeFS.rmSync(markerPath(baseDir), { force: true });
    }
    return true;
  } finally {
    installer.db.close();
  }
}

function readMarker(baseDir: string): Marker | undefined {
  let text: string;
  try {
    if (safeMarkerStat(baseDir) === undefined) return undefined;
    text = NodeFS.readFileSync(markerPath(baseDir), "utf8");
  } catch (cause) {
    if (isMissingEndpoint(cause)) return undefined;
    throw cause;
  }
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.nonce) ||
    !("socketPath" in value) ||
    typeof value.socketPath !== "string"
  )
    throw new Error("Service handoff marker is invalid.");
  const directory = NodePath.dirname(value.socketPath);
  const tempRoot = NodeFS.realpathSync(NodeOS.tmpdir());
  if (
    NodePath.basename(value.socketPath) !== "ready.sock" ||
    !NodePath.basename(directory).startsWith(SOCKET_DIRECTORY_PREFIX) ||
    NodePath.dirname(directory) !== tempRoot
  )
    throw new Error("Service handoff requires a private local socket.");
  const stat = NodeFS.lstatSync(directory, { throwIfNoEntry: false });
  if (
    stat !== undefined &&
    (!stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid && stat.uid !== process.getuid()))
  ) {
    throw new Error("Service handoff socket directory has unsafe permissions.");
  }
  const socket = NodeFS.lstatSync(value.socketPath, { throwIfNoEntry: false });
  if (
    socket !== undefined &&
    (!socket.isSocket() ||
      (socket.mode & 0o777) !== 0o600 ||
      (process.getuid && socket.uid !== process.getuid()))
  ) {
    throw new Error("Service handoff endpoint has unsafe ownership or permissions.");
  }
  return { nonce: value.nonce, socketPath: value.socketPath };
}

function removeMarker(baseDir: string, nonce: string): void {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(markerPath(baseDir), "utf8"));
    if (typeof value === "object" && value !== null && "nonce" in value && value.nonce === nonce) {
      NodeFS.rmSync(markerPath(baseDir), { force: true });
    }
  } catch (cause) {
    if (!(cause instanceof SyntaxError) && !isMissingEndpoint(cause)) throw cause;
  }
}

export async function prepareServiceHandoff(baseDir: string) {
  const installer = acquireServiceInstallerLease(baseDir);
  let gate: ReturnType<typeof acquireOwnershipLock> | undefined;
  let directory: string | undefined;
  let server: NodeNet.Server | undefined;
  const sockets = new Set<NodeNet.Socket>();
  const nonce = NodeCrypto.randomBytes(32).toString("hex");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      removeMarker(baseDir, nonce);
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (directory !== undefined) NodeFS.rmSync(directory, { recursive: true, force: true });
    } finally {
      try {
        gate?.db.close();
      } finally {
        installer.db.close();
      }
    }
  };
  try {
    try {
      gate = acquireOwnershipLock(NodePath.join(baseDir, "userdata", SERVER_OWNER_FILE), "shared");
    } catch (cause) {
      if (isBusy(cause)) {
        throw new Error(
          "Cannot replace this service while an older or standalone server holds exclusive ownership. This version requires a coordinated ownership migration before service installation or restart; no server was stopped.",
          { cause },
        );
      }
      throw cause;
    }
    directory = NodeFS.mkdtempSync(
      NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), SOCKET_DIRECTORY_PREFIX),
    );
    NodeFS.chmodSync(directory, 0o700);
    const socketPath = NodePath.join(directory, "ready.sock");
    const ready = Promise.withResolvers<void>();
    server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      let received = "";
      let accepted = false;
      socket.once("close", () => {
        sockets.delete(socket);
        if (accepted) ready.resolve();
      });
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.length > 65) return socket.destroy();
        if (!received.endsWith("\n")) return;
        if (received !== `${nonce}\n`) return socket.destroy();
        accepted = true;
        socket.end("ready\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, resolve);
    });
    NodeFS.chmodSync(socketPath, 0o600);
    const temporaryMarker = `${markerPath(baseDir)}.${nonce}.tmp`;
    const handle = NodeFS.openSync(temporaryMarker, "wx", 0o600);
    try {
      NodeFS.writeFileSync(handle, `${JSON.stringify({ nonce, socketPath })}\n`);
      NodeFS.fsyncSync(handle);
    } finally {
      NodeFS.closeSync(handle);
    }
    try {
      NodeFS.renameSync(temporaryMarker, markerPath(baseDir));
    } finally {
      NodeFS.rmSync(temporaryMarker, { force: true });
    }
    return {
      waitForReady: async (timeoutMs: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ready.promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "The replacement service launcher did not acknowledge native ownership.",
                    ),
                  ),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

/** Called only after the replacement launcher owns its compatibility and control leases. */
export async function acknowledgeServiceHandoff(baseDir: string): Promise<void> {
  if (removeAbandonedMarker(baseDir)) return;
  let marker: Marker | undefined;
  try {
    marker = readMarker(baseDir);
  } catch (cause) {
    if (removeAbandonedMarker(baseDir)) return;
    throw cause;
  }
  if (marker === undefined) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = NodeNet.createConnection(marker.socketPath);
      let received = "";
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`${marker.nonce}\n`));
      socket.on("data", (chunk) => {
        received += chunk.toString();
      });
      socket.once("end", () => {
        if (received === "ready\n") resolve();
        else reject(new Error("Service handoff acknowledgment was invalid."));
      });
    });
  } catch (cause) {
    if (!removeAbandonedMarker(baseDir)) throw cause;
  }
}
