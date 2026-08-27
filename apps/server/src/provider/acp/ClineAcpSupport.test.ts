import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as itx from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyClineAcpModelSelection,
  buildClineAcpSpawnInput,
  CLINE_PROCESS_FORCE_KILL_AFTER,
  currentClineModelIdFromSessionSetup,
  clineModelsFromSessionConfigOptions,
  makeClineAcpRuntime,
} from "./ClineAcpSupport.ts";

function modelSelectOption(
  overrides?: Partial<Extract<EffectAcpSchema.SessionConfigOption, { type: "select" }>>,
) {
  return {
    id: "model",
    name: "Model",
    category: "model" as const,
    type: "select" as const,
    currentValue: "cline/anthropic/claude-opus-4.7",
    options: [
      { value: "cline/anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
      { value: "cline/google/gemini-3-pro", name: "Gemini 3 Pro" },
    ],
    ...overrides,
  };
}

function providerSelectOption(): Extract<EffectAcpSchema.SessionConfigOption, { type: "select" }> {
  return {
    id: "provider",
    name: "Provider",
    category: "model",
    type: "select",
    currentValue: "cline",
    options: [
      { value: "cline", name: "Cline" },
      { value: "cline-pass", name: "ClinePass" },
      { value: "openai-codex", name: "ChatGPT Subscription" },
    ],
  };
}

const providerFirstConfigOptions = () => [providerSelectOption(), modelSelectOption()] as const;

function fakeRuntime(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly setCalls?: Array<{ configId: string; value: string | boolean }>;
}) {
  const setCalls = input.setCalls ?? [];
  return {
    getConfigOptions: Effect.succeed(input.configOptions),
    setConfigOption: (configId: string, value: string | boolean) => {
      setCalls.push({ configId, value });
      return Effect.succeed({
        configOptions: input.configOptions,
      } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
    },
  } as const;
}

describe("cline ACP support", () => {
  it("applies a force-kill bound only when the caller requests one", () => {
    expect(buildClineAcpSpawnInput({ binaryPath: "cline" }, "/workspace", undefined)).toEqual({
      command: "cline",
      args: ["--acp"],
      cwd: "/workspace",
    });
    expect(
      buildClineAcpSpawnInput(
        { binaryPath: "cline" },
        "/workspace",
        undefined,
        CLINE_PROCESS_FORCE_KILL_AFTER,
      ),
    ).toEqual({
      command: "cline",
      args: ["--acp"],
      cwd: "/workspace",
      forceKillAfter: "2 seconds",
    });
    expect(buildClineAcpSpawnInput({ binaryPath: "cline" }, "/workspace", undefined, 0)).toEqual({
      command: "cline",
      args: ["--acp"],
      cwd: "/workspace",
      forceKillAfter: 0,
    });
  });

  itx.it.effect("forwards an immediate force-kill bound to the ACP child command", () =>
    Effect.gen(function* () {
      let spawnedCommand:
        | {
            readonly options: {
              readonly forceKillAfter?: unknown;
            };
          }
        | undefined;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          spawnedCommand = command as unknown as typeof spawnedCommand;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );

      yield* makeClineAcpRuntime({
        childProcessSpawner: spawner,
        clineSettings: { binaryPath: "cline" },
        cwd: "/workspace",
        forceKillAfter: 0,
        clientInfo: { name: "t3-test", version: "0.0.0" },
      });

      expect(spawnedCommand?.options.forceKillAfter).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("reads the current model id from model-category config options", () => {
    const current = currentClineModelIdFromSessionSetup({
      sessionId: "ses_1",
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "code",
          options: [],
        },
        modelSelectOption(),
      ],
    });
    expect(current).toBe("cline/anthropic/claude-opus-4.7");
  });

  it("reads the exact model id when no option is tagged with the model category", () => {
    const current = currentClineModelIdFromSessionSetup({
      sessionId: "ses_1",
      configOptions: [modelSelectOption({ category: null })],
    });
    expect(current).toBe("cline/anthropic/claude-opus-4.7");
  });

  it("falls back to a non-provider model-category option for older agents", () => {
    const current = currentClineModelIdFromSessionSetup({
      sessionId: "ses_1",
      configOptions: [modelSelectOption({ id: "model-picker" })],
    });
    expect(current).toBe("cline/anthropic/claude-opus-4.7");
  });

  it("derives discovered models from config options and marks the current one default", () => {
    const models = clineModelsFromSessionConfigOptions({
      sessionId: "ses_1",
      // Official Cline emits its provider selector before its model selector,
      // and both use the ACP model category.
      configOptions: providerFirstConfigOptions(),
    });
    expect(models).toEqual([
      {
        slug: "cline/anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7",
        isDefault: true,
      },
      { slug: "cline/google/gemini-3-pro", name: "Gemini 3 Pro" },
    ]);
  });

  it("does not expose provider values as models when no model option exists", () => {
    const models = clineModelsFromSessionConfigOptions({
      sessionId: "ses_1",
      configOptions: [providerSelectOption()],
    });
    expect(models).toEqual([]);
  });

  it("preserves model names from grouped config options", () => {
    const models = clineModelsFromSessionConfigOptions({
      sessionId: "ses_1",
      configOptions: [
        modelSelectOption({
          options: [
            {
              group: "anthropic",
              name: "Anthropic",
              options: [{ value: "cline/anthropic/claude-opus-4.7", name: "Claude Opus 4.7" }],
            },
          ],
        }),
      ],
    });
    expect(models).toEqual([
      {
        slug: "cline/anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7",
        isDefault: true,
      },
    ]);
  });

  it("normalizes model values and names before filtering and deduplicating the catalog", () => {
    const models = clineModelsFromSessionConfigOptions({
      sessionId: "ses_1",
      configOptions: [
        modelSelectOption({
          currentValue: " model-a ",
          options: [
            {
              group: "primary",
              name: "Primary",
              options: [
                { value: "   ", name: "Ignored" },
                { value: " model-a ", name: "  Model A  " },
                { value: "model-a", name: "Duplicate" },
              ],
            },
            {
              group: "other",
              name: "Other",
              options: [
                { value: " model-b ", name: "   " },
                { value: "model-b", name: "Duplicate B" },
              ],
            },
          ],
        }),
      ],
    });

    expect(models).toEqual([
      { slug: "model-a", name: "Model A", isDefault: true },
      { slug: "model-b", name: "model-b" },
    ]);
  });

  it("returns no models without a select config option for models", () => {
    const models = clineModelsFromSessionConfigOptions({
      sessionId: "ses_1",
      configOptions: [
        { id: "autoApprove", name: "Auto approve", type: "boolean", currentValue: false },
      ],
    });
    expect(models).toEqual([]);
  });

  itx.it.effect("skips selection when the requested model is already current", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({
          configOptions: providerFirstConfigOptions(),
          setCalls,
        }),
        requestedModelId: "cline/anthropic/claude-opus-4.7",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("sets the model config option when the request differs", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({
          configOptions: providerFirstConfigOptions(),
          setCalls,
        }),
        requestedModelId: " cline/google/gemini-3-pro ",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(setCalls).toEqual([{ configId: "model", value: "cline/google/gemini-3-pro" }]);
    }),
  );

  itx.it.effect("does not write the provider option when no model option exists", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: [providerSelectOption()], setCalls }),
        requestedModelId: "cline/google/gemini-3-pro",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("does not write a requested model when Cline advertises an empty catalog", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({
          configOptions: [modelSelectOption({ currentValue: "", options: [] })],
          setCalls,
        }),
        requestedModelId: "gpt-5.6-sol",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("does nothing when the agent exposes no model config option", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: [], setCalls }),
        requestedModelId: "cline/google/gemini-3-pro",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("ignores empty model requests", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: [modelSelectOption()], setCalls }),
        requestedModelId: "   ",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("delegates explicit model selection to the runtime validation boundary", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: providerFirstConfigOptions(), setCalls }),
        requestedModelId: "cline/retired-model",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(setCalls).toEqual([{ configId: "model", value: "cline/retired-model" }]);
    }),
  );
});
