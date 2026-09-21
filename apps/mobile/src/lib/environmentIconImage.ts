import { ICON_IMAGE_DATA_URL_MAX_LENGTH, IconImageDataUrl } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { beginForegroundHandoff } from "./foreground-handoff";

/** Rendered edge of an uploaded icon. Rows draw it at 10 to 24 points. */
const ENVIRONMENT_ICON_IMAGE_EDGE = 64;

const isIconImageDataUrl = Schema.is(IconImageDataUrl);

export type EnvironmentIconImageResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: "cancelled" | "unreadable" | "too-large" };

/**
 * Lets the user pick a photo and renders it to a 64 by 64 PNG data URL that
 * fits the contract's cap. Decode, crop, and encode run natively; only the
 * bounded result crosses the bridge, and it is validated against the schema
 * so the caller writes exactly what the server will accept.
 */
export async function pickEnvironmentIconImage(): Promise<EnvironmentIconImageResult> {
  const imagePicker = await import("expo-image-picker");
  // The picker covers the Android activity, which reports the app as
  // backgrounded; the guard keeps background-triggered restarts away mid-pick.
  const endHandoff = beginForegroundHandoff();
  let picked: Awaited<ReturnType<typeof imagePicker.launchImageLibraryAsync>>;
  try {
    picked = await imagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      base64: false,
      quality: 1,
      shouldDownloadFromNetwork: true,
    });
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    endHandoff();
  }
  const asset = picked.canceled ? null : (picked.assets[0] ?? null);
  if (asset === null) return { ok: false, reason: "cancelled" };

  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  let image: Awaited<ReturnType<ReturnType<typeof ImageManipulator.manipulate>["renderAsync"]>>;
  try {
    image = await ImageManipulator.manipulate(asset.uri).renderAsync();
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const side = Math.min(image.width, image.height);
    if (side <= 0) return { ok: false, reason: "unreadable" };
    const squared = await ImageManipulator.manipulate(image)
      .crop({
        originX: Math.floor((image.width - side) / 2),
        originY: Math.floor((image.height - side) / 2),
        width: side,
        height: side,
      })
      .resize({ width: ENVIRONMENT_ICON_IMAGE_EDGE, height: ENVIRONMENT_ICON_IMAGE_EDGE })
      .renderAsync();
    try {
      const saved = await squared.saveAsync({ format: SaveFormat.PNG, base64: true });
      const dataUrl = `data:image/png;base64,${saved.base64 ?? ""}`;
      // Incompressible noise at this edge encodes to about 22 KB against a 32 KB
      // cap, so the guard is for a future change to either number, not for input.
      return isIconImageDataUrl(dataUrl)
        ? { ok: true, dataUrl }
        : { ok: false, reason: "too-large" };
    } finally {
      squared.release();
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    image.release();
  }
}

export function describeEnvironmentIconImageFailure(
  reason: Exclude<Extract<EnvironmentIconImageResult, { ok: false }>["reason"], "cancelled">,
): string {
  return reason === "too-large"
    ? `That image does not fit in ${Math.floor(ICON_IMAGE_DATA_URL_MAX_LENGTH / 1024)} KB even at 64 by 64. Try a simpler one.`
    : "That photo could not be read.";
}
