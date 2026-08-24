import { describe, expect, it, vi } from "vite-plus/test";

import { MessageId } from "@t3tools/contracts";

import { submitThreadComposerIfAllowed } from "./threadComposerSubmission";

describe("thread composer submission", () => {
  it("preserves the draft when native submission is blocked", async () => {
    let draft = "keep this prompt";
    const submit = vi.fn(async () => {
      draft = "";
      return MessageId.make("message-1");
    });

    await expect(
      submitThreadComposerIfAllowed({
        canSend: false,
        submit,
      }),
    ).resolves.toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(draft).toBe("keep this prompt");
  });

  it("forwards an allowed submission", async () => {
    const messageId = MessageId.make("message-1");

    await expect(
      submitThreadComposerIfAllowed({
        canSend: true,
        submit: async () => messageId,
      }),
    ).resolves.toBe(messageId);
  });
});
