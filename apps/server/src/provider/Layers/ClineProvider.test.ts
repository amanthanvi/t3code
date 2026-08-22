// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect } from "vite-plus/test";

import { ClineSettings } from "@t3tools/contracts";

import {
  buildInitialClineProviderSnapshot,
  checkClineProviderStatus,
  classifyClineDiscoveryFailure,
} from "./ClineProvider.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockClineWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-provider-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-cline.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
if [ "$1" = "--version" ]; then
  echo "cline 3.0.56"
  exit 0
fi
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

describe("classifyClineDiscoveryFailure", () => {
  it("treats the ACP authentication-required error code as unauthenticated", () => {
    expect(
      classifyClineDiscoveryFailure(
        Cause.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32000,
            errorMessage: "Call authenticate before starting a session",
            method: "session/new",
          }),
        ),
      ),
    ).toEqual({
      kind: "unauthenticated",
    });
  });

  it("classifies other failures with their error tag", () => {
    expect(
      classifyClineDiscoveryFailure(Cause.fail(EffectAcpErrors.AcpRequestError.internalError())),
    ).toEqual({
      kind: "failed",
      errorTag: "AcpRequestError",
    });
    expect(classifyClineDiscoveryFailure(Cause.die("boom"))).toEqual({
      kind: "failed",
      errorTag: "Die",
    });
  });

  it("does not treat unrelated server errors as authentication failures", () => {
    expect(
      classifyClineDiscoveryFailure(
        Cause.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32000,
            errorMessage: "Provider is still warming up",
            method: "session/new",
          }),
        ),
      ),
    ).toEqual({ kind: "failed", errorTag: "AcpRequestError" });
    expect(
      classifyClineDiscoveryFailure(
        Cause.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32000,
            errorMessage: "Authentication required",
            method: "initialize",
          }),
        ),
      ),
    ).toEqual({ kind: "failed", errorTag: "AcpRequestError" });
  });
});

describe("ClineProvider", () => {
  it.effect("builds a disabled initial snapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialClineProviderSnapshot(decodeClineSettings({}));
      expect(snapshot.displayName).toBe("Cline");
      expect(snapshot.badgeLabel).toBe("Early Access");
      expect(snapshot.showInteractionModeToggle).toBe(false);
      expect(snapshot.supportedRuntimeModes).toEqual(["full-access"]);
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("builds a checking initial snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialClineProviderSnapshot(
        decodeClineSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("Checking Cline CLI availability");
    }),
  );

  it.effect("reports an error when the CLI is missing", () =>
    checkClineProviderStatus(
      decodeClineSettings({
        enabled: true,
        binaryPath: NodePath.join(NodeOS.tmpdir(), "cline-does-not-exist"),
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((snapshot) => {
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toContain("npm install -g cline");
      }),
    ),
  );

  it.effect("discovers models over ACP when the CLI is healthy", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockClineWrapper());
      const snapshot = yield* checkClineProviderStatus(
        decodeClineSettings({ enabled: true, binaryPath }),
      ).pipe(Effect.provide(NodeServices.layer));
      expect(snapshot.version).toBe("3.0.56");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.supportsImageAttachments).toBe(false);

      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("composer-2");
      expect(slugs).toContain("gpt-5.3-codex[reasoning=medium,fast=false]");
      expect(snapshot.models.find((model) => model.slug === "composer-2")?.name).toBe("Composer 2");
      const defaults = snapshot.models.filter((model) => model.isDefault === true);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.slug).toBe("default");
    }),
  );

  it.effect("bounds hung ACP model discovery and terminates its child", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-provider-hung-discovery-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const binaryPath = yield* Effect.promise(() =>
        makeMockClineWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
          T3_ACP_HANG_INITIALIZE_FOREVER: "1",
          T3_ACP_IGNORE_SIGTERM: "1",
        }),
      );

      const snapshot = yield* checkClineProviderStatus(
        decodeClineSettings({ enabled: true, binaryPath }),
        process.env,
        { acpModelDiscoveryTimeout: "500 millis" },
      ).pipe(Effect.provide(NodeServices.layer));

      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("ACP startup failed");
      expect(yield* Effect.promise(() => NodeFSP.readFile(exitLogPath, "utf8"))).toContain(
        "SIGTERM",
      );
    }).pipe(TestClock.withLive),
  );

  it.effect(
    "reports saved-credential guidance without starting interactive ACP authentication",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() =>
          makeMockClineWrapper({ T3_ACP_REQUIRE_AUTHENTICATION: "1" }),
        );
        const snapshot = yield* checkClineProviderStatus(
          decodeClineSettings({ enabled: true, binaryPath }),
        ).pipe(Effect.provide(NodeServices.layer));

        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("`cline auth`");
        expect(snapshot.message).not.toContain("auth login");
      }),
  );

  it.effect("keeps advertised models available without exposing configured unadvertised ids", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() => makeMockClineWrapper());
      const snapshot = yield* checkClineProviderStatus(
        decodeClineSettings({
          enabled: true,
          binaryPath,
          customModels: ["composer-2", "cline/custom/unadvertised"],
        }),
      ).pipe(Effect.provide(NodeServices.layer));
      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("composer-2");
      expect(slugs).not.toContain("cline/custom/unadvertised");
      const customModel = snapshot.models.find((model) => model.slug === "composer-2");
      expect(customModel?.isCustom).toBe(false);
    }),
  );

  it.effect("reports an authenticated error when Cline advertises no usable models", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_EMPTY_MODEL_CATALOG: "1" }),
      );
      const snapshot = yield* checkClineProviderStatus(
        decodeClineSettings({
          enabled: true,
          binaryPath,
          customModels: ["cline/custom/unadvertised"],
        }),
      ).pipe(Effect.provide(NodeServices.layer));

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("did not advertise any usable models");
    }),
  );
});
