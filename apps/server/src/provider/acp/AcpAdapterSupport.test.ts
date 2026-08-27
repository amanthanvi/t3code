import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  mapAcpToAdapterError,
  selectAutoApprovedPermissionOption,
  selectPermissionOptionId,
} from "./AcpAdapterSupport.ts";

const decodePermissionRequest = Schema.decodeUnknownSync(EffectAcpSchema.RequestPermissionRequest);

const permissionRequest = (
  options: ReadonlyArray<{ optionId: string; name: string; kind: string }>,
) =>
  decodePermissionRequest({
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-1" },
    options,
  });

describe("AcpAdapterSupport", () => {
  it("selects the option advertised by the request for each decision", () => {
    const request = permissionRequest([
      { optionId: "opt-allow", name: "Allow once", kind: "allow_once" },
      { optionId: "opt-always", name: "Allow always", kind: "allow_always" },
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
    ]);

    expect(selectPermissionOptionId(request, "accept")).toBe("opt-allow");
    expect(selectPermissionOptionId(request, "acceptForSession")).toBe("opt-always");
    expect(selectPermissionOptionId(request, "decline")).toBe("opt-reject");
    expect(selectAutoApprovedPermissionOption(request)).toBe("opt-always");
  });

  it("returns undefined when the request offers no matching option", () => {
    const request = permissionRequest([
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
    ]);

    expect(selectPermissionOptionId(request, "accept")).toBeUndefined();
    expect(selectAutoApprovedPermissionOption(request)).toBeUndefined();
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
