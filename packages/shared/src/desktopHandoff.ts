// @effect-diagnostics nodeBuiltinImport:off - Native desktop and the bundled reservation worker share this process boundary.
// @effect-diagnostics globalTimers:off - The worker must run without an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { acknowledgeNativeHandoff, prepareNativeHandoff } from "./nativeOwnershipHandoff.ts";

export const acknowledgeDesktopHandoff = (baseDir: string) =>
  acknowledgeNativeHandoff(baseDir, "desktop");

export async function startDesktopHandoff(options: {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly baseDir: string;
}) {
  const child = NodeChildProcess.spawn(options.executablePath, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = Promise.withResolvers<void>();
  child.once("exit", () => exited.resolve());
  child.once("error", () => exited.resolve());
  child.stdin.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      let received = "";
      const timer = setTimeout(
        () => reject(new Error("Desktop handoff worker was not ready.")),
        10_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.stdout.off("data", onData);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onError = (cause: Error) => finish(cause);
      const onExit = () => finish(new Error("Desktop handoff worker exited before readiness."));
      const onData = (chunk: Buffer) => {
        received += chunk.toString();
        if (received === "ready\n") finish();
        else if (received.length > 6)
          finish(new Error("Desktop handoff worker readiness was invalid."));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout.on("data", onData);
      child.stdin.write(`${JSON.stringify({ baseDir: options.baseDir })}\n`);
    });
  } catch (cause) {
    child.kill();
    await exited.promise;
    throw cause;
  }
  child.stdout.resume();
  child.unref();
  return {
    assertAlive: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Desktop handoff worker lost its reservation.");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Desktop handoff worker stopped responding.")),
          1_000,
        );
        let received = "";
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.off("exit", onExit);
          child.stdout.off("data", onData);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onExit = () => finish(new Error("Desktop handoff worker lost its reservation."));
        const onData = (chunk: Buffer) => {
          received += chunk.toString();
          if (received === "alive\n") finish();
          else if (received.length > 6)
            finish(new Error("Desktop handoff liveness response was invalid."));
        };
        child.once("exit", onExit);
        child.stdout.on("data", onData);
        child.stdin.write("check\n");
      });
    },
    cancel: async () => {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end("cancel\n");
      await exited.promise;
    },
  };
}

export async function runDesktopHandoff(): Promise<void> {
  const bootstrap = Promise.withResolvers<string>();
  const cancelled = Promise.withResolvers<void>();
  void cancelled.promise.catch(() => {});
  const input = (async () => {
    let pending = "";
    let initialized = false;
    for await (const chunk of process.stdin) {
      pending += String(chunk);
      if (pending.length > 16_384) throw new Error("Desktop handoff input was too large.");
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!initialized) {
          const value: unknown = JSON.parse(line);
          if (
            typeof value !== "object" ||
            value === null ||
            !("baseDir" in value) ||
            typeof value.baseDir !== "string" ||
            !NodePath.isAbsolute(value.baseDir)
          )
            throw new Error("Desktop handoff home was invalid.");
          initialized = true;
          bootstrap.resolve(value.baseDir);
        } else if (line === "check") {
          process.stdout.write("alive\n");
        } else if (line === "cancel") {
          cancelled.resolve();
        } else throw new Error("Desktop handoff command was invalid.");
      }
    }
    if (!initialized) throw new Error("Desktop handoff bootstrap was missing.");
  })();
  input.catch((cause) => {
    bootstrap.reject(cause);
    cancelled.reject(cause);
  });
  const handoff = await prepareNativeHandoff(await bootstrap.promise, "desktop");
  try {
    process.stdout.write("ready\n");
    await Promise.race([handoff.waitForReady(), cancelled.promise]);
  } finally {
    await handoff.close();
  }
  process.stdin.destroy();
}
