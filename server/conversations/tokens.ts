/** Lightweight estimate that does not add a tokenizer dependency. CJK and other
 * non-ASCII text receive a denser estimate than Latin text. */
export function estimateTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.charCodeAt(0) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.5));
}
