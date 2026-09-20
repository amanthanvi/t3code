import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Leaf schemas shared by every user-chosen icon (project overrides and
 * environment overrides). The composite override shapes differ per owner and
 * live beside the owner; only the pieces that must agree across them live here.
 */

export const IconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type IconColor = typeof IconColor.Type;

/** A Lucide icon id, or any curated id that follows the same kebab-case grammar. */
export const LucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type LucideIconName = typeof LucideIconName.Type;

export const IconEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
export type IconEmoji = typeof IconEmoji.Type;

// Grapheme-count validation belongs to the write boundary, not snapshot decoding.
export const MonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);
export type MonogramText = typeof MonogramText.Type;

/** Whether `text` reads as at most two characters, the bound a monogram tile can hold. */
export function isMonogramLength(text: string): boolean {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  const count =
    typeof Segmenter === "function"
      ? Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length
      : Array.from(text.replace(/\p{M}/gu, "")).length;
  return count <= 2;
}

/**
 * Encoded length budget for an inline raster icon. A 64 by 64 PNG with alpha
 * is at most 16 KiB of pixels before compression, which base64 grows by a
 * third; the cap leaves room for the container without admitting a photo.
 */
export const ICON_IMAGE_DATA_URL_MAX_LENGTH = 32_768;

/**
 * A small raster icon carried inline. The prefix is pinned to two known
 * raster types rather than any `data:image/` so an SVG, which can script,
 * never reaches a renderer through this field.
 */
export const IconImageDataUrl = Schema.String.check(
  Schema.isMaxLength(ICON_IMAGE_DATA_URL_MAX_LENGTH),
  Schema.isPattern(/^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
);
export type IconImageDataUrl = typeof IconImageDataUrl.Type;
