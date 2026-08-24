/**
 * Optional integration check against a real `cline --acp` install.
 * Enable with: T3_CLINE_ACP_PROBE=1 bun run test ClineAcpCliProbe
 *
 * Cline's ACP mode requires credentials before session/new. Authenticate with
 * `cline auth` first or provide CLINE_API_KEY; the T3 runtime intentionally
 * does not call ACP authenticate because that starts an interactive OAuth flow.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import {
  applyClineAcpModelSelection,
  currentClineModelIdFromSessionSetup,
  clineModelsFromSessionConfigOptions,
  makeClineAcpRuntime,
} from "./ClineAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeClineAcpRuntime({
    clineSettings: { binaryPath: "cline" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.env.T3_CLINE_ACP_PROBE_CWD ?? process.cwd(),
    clientInfo: { name: "t3-cline-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_CLINE_ACP_PROBE === "1")("Cline ACP CLI probe", () => {
  it.effect("initializes and creates a session against real cline acp", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(typeof started.sessionId).toBe("string");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises a model select in configOptions", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();

      const models = clineModelsFromSessionConfigOptions(started.sessionSetupResult);
      expect(models.length).toBeGreaterThan(0);

      const current = currentClineModelIdFromSessionSetup(started.sessionSetupResult);
      expect(current).toBeDefined();
      if (current === undefined) return;
      expect(models.some((model) => model.slug === current)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("no-op model selection succeeds against the live catalog", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();

      // Selecting the model the session already runs on must resolve without
      // issuing a session/set_config_option round-trip against every Cline
      // build that implements config-option selects.
      const selected = yield* applyClineAcpModelSelection({
        runtime,
        requestedModelId: currentClineModelIdFromSessionSetup(started.sessionSetupResult),
        mapError: (cause) => cause,
      });
      expect(selected).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
