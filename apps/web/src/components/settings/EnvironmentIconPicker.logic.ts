import {
  environmentIconForMachineKind,
  isEnvironmentMachineKind,
  MonogramText,
  type EnvironmentCuratedIconId,
  type EnvironmentIcon,
  type EnvironmentMachineKind,
  type IconColor,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { firstEmoji } from "../../iconEmoji";

const isMonogramText = Schema.is(MonogramText);
const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Why the picker is inert, in the order the user can do something about it.
 * Null means it can be changed.
 */
export function resolveEnvironmentIconPickerLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its icon.";
  }
  if (input.serverConfig.environment.capabilities.environmentIcon !== true) {
    return "This environment's server is too old to keep an icon. Update it to choose one.";
  }
  if (input.operateAccess === "denied") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}

/**
 * Only a plain pick of one of the seven machine kinds has a string form an
 * older server accepts; a role, a color, an emoji, or a monogram travels as
 * the object, which such a server rejects. Null means it can be picked.
 */
export function resolveEnvironmentIconChoiceLock(input: {
  readonly serverConfig: ServerConfig | null;
  readonly id: EnvironmentCuratedIconId;
}): string | null {
  if (isEnvironmentMachineKind(input.id)) return null;
  return resolveEnvironmentRichIconLock(input.serverConfig);
}

/** Why anything beyond a plain machine kind cannot be written to this server; null when it can. */
export function resolveEnvironmentRichIconLock(serverConfig: ServerConfig | null): string | null {
  return serverConfig?.environment.capabilities.environmentIconOverride === true
    ? null
    : "Update this environment's server to pick an icon beyond its machine kind.";
}

/**
 * What to store for a plain named pick. Picking what the server would draw
 * anyway clears the override instead of pinning it, so detection keeps
 * working if the machine changes; a machine kind gets the shared reference,
 * so renderers memoized on the icon do not repaint for the same pick.
 */
function resolveNamedIconWrite(input: {
  readonly next: EnvironmentCuratedIconId;
  readonly detected: EnvironmentMachineKind;
}): EnvironmentIcon | null {
  if (input.next === input.detected) return null;
  // A plain machine kind encodes to the bare string on the wire, so a server
  // that predates the object form accepts it unchanged; a role stays an object.
  return isEnvironmentMachineKind(input.next)
    ? environmentIconForMachineKind(input.next)
    : { kind: "icon", name: input.next };
}

export type EnvironmentIconDialogMode = "icon" | "emoji" | "monogram";

export type EnvironmentIconDialogWrite =
  | { readonly kind: "write"; readonly icon: EnvironmentIcon | null }
  | { readonly kind: "invalid"; readonly reason: string };

/** Monograms are stored upper-case and NFKC-composed so equal text compares equal. */
function normalizeMonogram(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

/**
 * The value the dialog would save for its current state, or why it cannot.
 * The monogram bound is checked here and not only in the schema, because an
 * environment has no decider to catch what the picker lets through: the
 * schema is the only backstop, and this keeps that error away from the user.
 */
export function resolveEnvironmentIconDialogWrite(input: {
  readonly mode: EnvironmentIconDialogMode;
  readonly iconId: EnvironmentCuratedIconId;
  readonly color: IconColor | null;
  readonly emoji: string;
  readonly monogram: string;
  readonly detected: EnvironmentMachineKind;
}): EnvironmentIconDialogWrite {
  switch (input.mode) {
    case "icon":
      return {
        kind: "write",
        icon:
          input.color === null
            ? resolveNamedIconWrite({ next: input.iconId, detected: input.detected })
            : { kind: "icon", name: input.iconId, color: input.color },
      };
    case "emoji":
      return firstEmoji(input.emoji) === input.emoji
        ? { kind: "write", icon: { kind: "emoji", emoji: input.emoji } }
        : { kind: "invalid", reason: "Pick an emoji." };
    case "monogram": {
      const text = normalizeMonogram(input.monogram);
      if (!isMonogramText(text) || Array.from(monogramSegmenter.segment(text)).length > 2) {
        return { kind: "invalid", reason: "One or two letters or numbers." };
      }
      return {
        kind: "write",
        icon:
          input.color === null
            ? { kind: "monogram", text }
            : { kind: "monogram", text, color: input.color },
      };
    }
  }
}
