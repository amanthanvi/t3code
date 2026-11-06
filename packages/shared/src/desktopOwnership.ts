// @effect-diagnostics nodeBuiltinImport:off - Native desktop ownership uses inherited sockets and SQLite leases.
// @effect-diagnostics globalTimers:off - This handshake also runs before the server Effect runtime starts.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  acquireOwnershipLock,
  SERVER_OWNER_FILE,
  SERVICE_LAUNCHER_OWNER_FILE,
} from "./serverOwnershipLock.ts";

// Scope teardown must not let GC release the parent reservation before Electron actually exits.
const exitReservations = new Set<object>();

export function acquireDesktopSupervisor(baseDir: string) {
  const controller = acquireOwnershipLock(
    NodePath.join(baseDir, "userdata", SERVICE_LAUNCHER_OWNER_FILE),
    "exclusive",
  );
  try {
    const gate = acquireOwnershipLock(
      NodePath.join(baseDir, "userdata", SERVER_OWNER_FILE),
      "shared",
    );
    const supervisor = {
      retainUntilExit() {
        exitReservations.add(supervisor);
      },
      resume() {
        exitReservations.delete(supervisor);
      },
      close() {
        exitReservations.delete(supervisor);
        try {
          gate.db.close();
        } finally {
          controller.db.close();
        }
      },
    };
    return supervisor;
  } catch (cause) {
    controller.db.close();
    throw cause;
  }
}

export function desktopOwnershipResponse(line: string, nonce: string): string {
  const parts = line.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "challenge" ||
    parts[1] !== nonce ||
    !/^[a-f0-9]{64}$/.test(parts[2]!)
  ) {
    throw new Error("Invalid desktop ownership challenge.");
  }
  return `owned:${nonce}:${parts[2]}\n`;
}

/** A bootstrap value alone cannot admit a shared writer: the inherited live parent must answer. */
export async function authenticateDesktopSupervisor(input: {
  readonly fd: 8;
  readonly nonce: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.nonce)) throw new Error("Invalid desktop ownership nonce.");
  const socket = new NodeNet.Socket({ fd: input.fd, readable: true, writable: true });
  const challenge = NodeCrypto.randomBytes(32).toString("hex");
  const lost = Promise.withResolvers<void>();
  let connected = true;
  const disconnected = () => {
    connected = false;
    lost.resolve();
  };
  socket.on("error", disconnected);
  socket.once("end", disconnected);
  socket.once("close", disconnected);
  try {
    await new Promise<void>((resolve, reject) => {
      let received = "";
      socket.setTimeout(5_000, () =>
        socket.destroy(new Error("Desktop ownership challenge timed out.")),
      );
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Desktop ownership channel disconnected.")));
      socket.on("data", (chunk) => {
        received += chunk.toString();
        const expected = `owned:${input.nonce}:${challenge}\n`;
        if (
          received.length > expected.length ||
          (received.endsWith("\n") && received !== expected)
        ) {
          socket.destroy(new Error("Invalid desktop ownership acknowledgment."));
        } else if (received === expected) {
          socket.setTimeout(0);
          resolve();
        }
      });
      socket.write(`challenge:${input.nonce}:${challenge}\n`);
    });
    if (!connected) throw new Error("Desktop ownership channel disconnected.");
    return {
      connected: () => connected && !socket.destroyed,
      lost: lost.promise,
      close: () => socket.destroy(),
    };
  } catch (cause) {
    socket.destroy();
    throw cause;
  }
}
