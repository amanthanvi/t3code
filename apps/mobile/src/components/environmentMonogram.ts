import { firstGrapheme } from "../lib/grapheme";

/**
 * The one or two user-perceived characters a monogram shows. The write schema
 * caps the text at two, so this returns the whole value for anything the
 * picker can produce and the tile sizes the glyphs to fit. A longer value,
 * which only a peer writing outside the picker can store, is cut to two here
 * and drawn whole on web.
 */
export function monogramCharacters(text: string): ReadonlyArray<string> {
  const first = firstGrapheme(text);
  const rest = text.slice(first.length);
  return rest.length === 0 ? [first] : [first, firstGrapheme(rest)];
}
