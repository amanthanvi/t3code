import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  environmentIconForMachineKind,
  resolveEnvironmentIcon,
  ServerConfig,
  ServerObservability,
  ServerProvider,
  ServerProviders,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const decodeServerObservability = Schema.decodeUnknownSync(ServerObservability);
const decodeUpsertKeybindingResult = Schema.decodeUnknownSync(ServerUpsertKeybindingResult);
const decodeAvailableEditors = Schema.decodeUnknownSync(ServerConfig.fields.availableEditors);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes optional legacy model metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          isLegacy: true,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.isLegacy).toBe(true);
  });
});

describe("server config forward compatibility", () => {
  it("drops config issues with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      issues: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.issues).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  // A provider status this build has never seen (a new ServerProviderState,
  // ServerProviderAuthStatus, etc. member) previously failed the whole
  // `providers` array, taking every other provider down with it and, since
  // `providers` sits inside `ServerConfig`, failing the whole config decode —
  // an older client would drop its connection over one provider it can't
  // render. Dropping just that element keeps every other provider working.
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });

  it("drops usage windows this build cannot decode instead of failing the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
          { id: "future", kind: "some-future-kind", label: "Future", usedPercent: 1 },
          { id: "bad", kind: "weekly", label: "Weekly", usedPercent: 120 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toEqual([
      { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
    ]);
  });
});

describe("ServerObservability", () => {
  it("reads a server from before the log signal as exporting no logs", () => {
    const parsed = decodeServerObservability({
      logsDirectoryPath: "/tmp/t3/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "https://collector.example.com/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    });

    expect(parsed.otlpLogsEnabled).toBe(false);
    expect(parsed.otlpLogsUrl).toBeUndefined();
  });
});

describe("resolveEnvironmentIcon", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const descriptor = (platform: Record<string, unknown>) =>
    decodeDescriptor({
      environmentId: "env-1",
      label: "Box",
      platform: { os: "linux", arch: "x64", ...platform },
      serverVersion: "1.0.0",
      capabilities: {},
    });

  it("prefers the user's pick over what the server detected", () => {
    expect(
      resolveEnvironmentIcon({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({ environmentIcon: "laptop" }),
      }),
    ).toEqual({ kind: "icon", name: "laptop" });
  });

  it("returns a named icon outside the machine kinds as stored", () => {
    const settings = decodeSettings({ environmentIcon: { kind: "icon", name: "cpu" } });
    expect(
      resolveEnvironmentIcon({ environment: descriptor({ machine: "mac-mini" }), settings }),
    ).toBe(settings.environmentIcon);
  });

  it("returns the stored value for anything richer than a plain kind", () => {
    const settings = decodeSettings({ environmentIcon: { kind: "emoji", emoji: "🚀" } });
    expect(
      resolveEnvironmentIcon({ environment: descriptor({ machine: "mac-mini" }), settings }),
    ).toBe(settings.environmentIcon);

    const colored = decodeSettings({
      environmentIcon: { kind: "icon", name: "laptop", color: "red" },
    });
    expect(
      resolveEnvironmentIcon({
        environment: descriptor({ machine: "mac-mini" }),
        settings: colored,
      }),
    ).toBe(colored.environmentIcon);
  });

  it("uses detection when nothing is picked", () => {
    expect(
      resolveEnvironmentIcon({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({}),
      }),
    ).toEqual({ kind: "icon", name: "mac-mini" });
  });

  it("uses detection from a bare descriptor before connecting", () => {
    expect(resolveEnvironmentIcon({ environment: descriptor({ machine: "laptop" }) })).toEqual({
      kind: "icon",
      name: "laptop",
    });
  });

  it("falls back to a server for older servers and before connect", () => {
    expect(
      resolveEnvironmentIcon({
        environment: descriptor({}),
        settings: decodeSettings({}),
      }),
    ).toEqual({ kind: "icon", name: "server" });
    expect(resolveEnvironmentIcon(null)).toEqual({ kind: "icon", name: "server" });
  });

  it("hands back one reference per plain kind so memoized rows can skip", () => {
    const detected = resolveEnvironmentIcon({ environment: descriptor({ machine: "laptop" }) });
    expect(detected).toBe(environmentIconForMachineKind("laptop"));
    // A pick decoded from a fresh settings snapshot still lands on that reference.
    expect(
      resolveEnvironmentIcon({
        environment: descriptor({}),
        settings: decodeSettings({ environmentIcon: { kind: "icon", name: "laptop" } }),
      }),
    ).toBe(detected);
    expect(resolveEnvironmentIcon(null)).toBe(environmentIconForMachineKind("server"));
  });
});
