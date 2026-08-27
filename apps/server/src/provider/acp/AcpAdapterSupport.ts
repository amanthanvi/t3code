import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { AcpSessionMode, AcpSessionModeState } from "./AcpRuntimeModel.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

/** Flattens a handler failure into the transport error ACP callbacks must return. */
export const mapAcpHandlerFailure =
  (method: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, EffectAcpErrors.AcpTransportError, R> =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: `Failed to process ACP '${method}' handler.`,
            cause,
          }),
      ),
    );

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

export const ACP_PLAN_MODE_ALIASES: ReadonlyArray<string> = ["plan", "architect"];
export const ACP_IMPLEMENT_MODE_ALIASES: ReadonlyArray<string> = [
  "code",
  "agent",
  "default",
  "chat",
  "implement",
];
export const ACP_APPROVAL_MODE_ALIASES: ReadonlyArray<string> = ["ask"];

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

export function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

export function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
  /** Providers with extra implement-mode names prepend them here (e.g. Cline's "act"). */
  readonly implementModeAliases?: ReadonlyArray<string>;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }
  const implementAliases = input.implementModeAliases ?? ACP_IMPLEMENT_MODE_ALIASES;

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, implementAliases)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, implementAliases)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

/** Builds a decoder for the `{schemaVersion, sessionId}` resume cursor every ACP adapter persists. */
export function makeAcpResumeCursorParser(
  schemaVersion: number,
): (raw: unknown) => { readonly sessionId: string } | undefined {
  const decodeResumeExit = Schema.decodeUnknownExit(
    Schema.Struct({
      schemaVersion: Schema.Literal(schemaVersion),
      sessionId: Schema.String,
    }),
  );
  return (raw) => {
    const decoded = decodeResumeExit(raw);
    if (Exit.isFailure(decoded)) return undefined;
    const sessionId = decoded.value.sessionId.trim();
    return sessionId.length > 0 ? { sessionId } : undefined;
  };
}

/** MCP server list advertised to ACP agents when a T3 MCP session exists for the thread. */
export function mcpServersForThread(
  threadId: ThreadId,
): ReadonlyArray<EffectAcpSchema.McpServer> | undefined {
  const mcpSession = McpProviderSession.readMcpProviderSession(threadId);
  if (!mcpSession) {
    return undefined;
  }
  return [
    {
      type: "http",
      name: "t3-code",
      url: mcpSession.endpoint,
      headers: [
        {
          name: "Authorization",
          value: mcpSession.authorizationHeader,
        },
      ],
    },
  ];
}
