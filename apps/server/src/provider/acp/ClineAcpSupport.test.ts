import { describe, expect, it } from "vite-plus/test";
import * as itx from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyClineAcpModelSelection,
  buildClineAcpSpawnInput,
  CLINE_PROCESS_FORCE_KILL_AFTER,
  currentClineModelIdFromSessionSetup,
  clineModelsFromSessionConfigOptions,
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
  });

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
      const result = yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({
          configOptions: providerFirstConfigOptions(),
          setCalls,
        }),
        requestedModelId: "cline/anthropic/claude-opus-4.7",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(result).toBe("cline/anthropic/claude-opus-4.7");
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("sets the model config option when the request differs", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      const result = yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({
          configOptions: providerFirstConfigOptions(),
          setCalls,
        }),
        requestedModelId: " cline/google/gemini-3-pro ",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(result).toBe("cline/google/gemini-3-pro");
      expect(setCalls).toEqual([{ configId: "model", value: "cline/google/gemini-3-pro" }]);
    }),
  );

  itx.it.effect("does not write the provider option when no model option exists", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      const result = yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: [providerSelectOption()], setCalls }),
        requestedModelId: "cline/google/gemini-3-pro",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(result).toBeUndefined();
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("does not write a requested model when Cline advertises an empty catalog", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      const result = yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({
          configOptions: [modelSelectOption({ currentValue: "", options: [] })],
          setCalls,
        }),
        requestedModelId: "gpt-5.6-sol",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(result).toBeUndefined();
      expect(setCalls).toEqual([]);
    }),
  );

  itx.it.effect("does nothing when the agent exposes no model config option", () =>
    Effect.gen(function* () {
      const result = yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: [] }),
        requestedModelId: "cline/google/gemini-3-pro",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(result).toBeUndefined();
    }),
  );

  itx.it.effect("ignores empty model requests", () =>
    Effect.gen(function* () {
      const result = yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: [modelSelectOption()] }),
        requestedModelId: "   ",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(result).toBeUndefined();
    }),
  );

  itx.it.effect("delegates explicit model selection to the runtime validation boundary", () =>
    Effect.gen(function* () {
      const setCalls: Array<{ configId: string; value: string | boolean }> = [];
      const result = yield* applyClineAcpModelSelection({
        runtime: fakeRuntime({ configOptions: providerFirstConfigOptions(), setCalls }),
        requestedModelId: "cline/retired-model",
        mapError: (cause): EffectAcpErrors.AcpError => cause,
      });
      expect(result).toBe("cline/retired-model");
      expect(setCalls).toEqual([{ configId: "model", value: "cline/retired-model" }]);
    }),
  );
});
