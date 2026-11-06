import type { authenticateDesktopSupervisor } from "@t3tools/shared/desktopOwnership";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export class DesktopSupervisorOwnershipError extends Schema.TaggedError<DesktopSupervisorOwnershipError>()(
  "DesktopSupervisorOwnershipError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The native desktop ownership channel is unavailable.";
  }
}

export class DesktopSupervisorOwnership extends Context.Service<
  DesktopSupervisorOwnership,
  Awaited<ReturnType<typeof authenticateDesktopSupervisor>>
>()("t3/desktopOwnership/DesktopSupervisorOwnership") {}
