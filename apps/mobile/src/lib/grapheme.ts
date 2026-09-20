/**
 * First user-perceived character of `text`. Hermes may or may not ship
 * `Intl.Segmenter` in a given build, and nothing in the app proves either
 * way, so this uses it when present and otherwise takes a base character
 * with its combining marks, which is right for the letters and digits a
 * monogram is made of.
 */
export function firstGrapheme(text: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Segmenter === "function") {
    const segments = new Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    const first = segments[Symbol.iterator]().next().value;
    if (first) return first.segment;
  }
  return /^[\s\S]\p{M}*/u.exec(text)?.[0] ?? text;
}
