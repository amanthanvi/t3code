/**
 * First character of `text` as a monogram counts one, a base character with
 * the combining marks and joiners that bind to it. For the letters and digits
 * a monogram is made of, that is the character a reader sees. It is also the
 * count `isMonogramLength` holds the text to, so the tiles never disagree with
 * the bound the picker enforced. It splits a Devanagari conjunct that grapheme
 * segmentation keeps whole. `Intl.Segmenter` would not, and Hermes ships none.
 *
 * The joiners matter because `MonogramText` admits them. Without them
 * "A\u200dB" would split into "A" and the bare joiner. The second tile
 * would draw an invisible character while the "B" vanished.
 */
export function firstGrapheme(text: string): string {
  return /^[\s\S][\p{M}\u200c\u200d]*/u.exec(text)?.[0] ?? text;
}
