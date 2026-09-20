import { firstGrapheme } from "../lib/grapheme";

/**
 * The one or two user-perceived characters a monogram shows. Web draws the
 * whole text at every size, so mobile does too; the tile sizes the glyphs to
 * fit rather than dropping one, or the same machine would read `K` on the
 * phone and `K8` on the desktop.
 */
export function monogramCharacters(text: string): ReadonlyArray<string> {
  const first = firstGrapheme(text);
  const rest = text.slice(first.length);
  return rest.length === 0 ? [first] : [first, firstGrapheme(rest)];
}
