/**
 * First user-perceived character of `text`. Hermes may or may not ship
 * `Intl.Segmenter` in a given build, and nothing in the app proves either
 * way, so this uses it when present and otherwise takes a base character
 * with the combining marks and joiners that bind to it, which is right for
 * the letters and digits a monogram is made of.
 *
 * The joiners matter because `MonogramText` admits them: without them
 * "A\u200dB" would split as "A" and "\u200d", and the second tile would
 * draw an invisible joiner while the "B" vanished. The fallback still splits
 * a Devanagari conjunct that `Intl.Segmenter` keeps whole.
 */
export function firstGrapheme(text: string): string {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Segmenter === "function") {
    const segments = new Segmenter(undefined, { granularity: "grapheme" }).segment(text);
    const first = segments[Symbol.iterator]().next().value;
    if (first) return first.segment;
  }
  return /^[\s\S][\p{M}\u200c\u200d]*/u.exec(text)?.[0] ?? text;
}
