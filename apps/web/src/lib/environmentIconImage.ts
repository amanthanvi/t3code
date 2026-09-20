import { ICON_IMAGE_DATA_URL_MAX_LENGTH, IconImageDataUrl } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Rendered edge of an uploaded icon. Rows draw it at 12 to 32 CSS pixels. */
const ENVIRONMENT_ICON_IMAGE_EDGE = 64;

const isIconImageDataUrl = Schema.is(IconImageDataUrl);

export type EnvironmentIconImageResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: "unreadable" | "too-large" };

/**
 * Downscales `file` to a 64 by 64 PNG data URL that fits the contract's cap.
 * The source is decoded through `createImageBitmap`, so an SVG or a file
 * that only claims to be an image never reaches the encoder as bytes; the
 * result is validated against the schema so the caller writes exactly what
 * the server will accept.
 */
export async function encodeEnvironmentIconImage(file: Blob): Promise<EnvironmentIconImageResult> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side <= 0) return { ok: false, reason: "unreadable" };
    const canvas = document.createElement("canvas");
    canvas.width = ENVIRONMENT_ICON_IMAGE_EDGE;
    canvas.height = ENVIRONMENT_ICON_IMAGE_EDGE;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, reason: "unreadable" };
    // One step from full resolution to 64 pixels; the default filter aliases.
    context.imageSmoothingQuality = "high";
    // Center crop to a square, then fit; a machine icon is a tile, not a photo.
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      ENVIRONMENT_ICON_IMAGE_EDGE,
      ENVIRONMENT_ICON_IMAGE_EDGE,
    );
    const png = canvas.toDataURL("image/png");
    if (isIconImageDataUrl(png)) return { ok: true, dataUrl: png };
    // A busy image can exceed the cap as PNG; WebP at high quality is smaller
    // and keeps alpha. Browsers that cannot encode it return a PNG instead.
    const webp = canvas.toDataURL("image/webp", 0.9);
    if (webp.startsWith("data:image/webp") && isIconImageDataUrl(webp)) {
      return { ok: true, dataUrl: webp };
    }
    return { ok: false, reason: "too-large" };
  } finally {
    bitmap.close();
  }
}

export function describeEnvironmentIconImageFailure(
  reason: Extract<EnvironmentIconImageResult, { ok: false }>["reason"],
): string {
  return reason === "too-large"
    ? `That image does not fit in ${Math.floor(ICON_IMAGE_DATA_URL_MAX_LENGTH / 1024)} KB even at 64 by 64. Try a simpler one.`
    : "That file could not be read as an image.";
}
