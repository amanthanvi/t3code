import type { MessageId } from "@t3tools/contracts";

export function submitThreadComposerIfAllowed(input: {
  readonly canSend: boolean;
  readonly submit: () => Promise<MessageId | null>;
}): Promise<MessageId | null> {
  return input.canSend ? input.submit() : Promise.resolve(null);
}
