// OSC (title, hyperlinks, clipboard) up to BEL or ST; CSI (colors, cursor movement, erase); then any stray ESC.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g
// C0 except \n and \t, DEL, C1, line/paragraph separators, and invisible or reordering characters that are
// used to disguise text: zero-width space, word joiner, BOM, bidi embeddings/overrides/isolates.
// Kept on purpose: ZWNJ/ZWJ and LRM/RLM, which real Persian, Arabic, Indic and emoji text needs.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g

/**
 * Makes model- or file-sourced text safe to print in a terminal: removes escape sequences and control
 * characters that could move the cursor, erase lines, rewrite a title or hide text, e.g. to spoof an
 * approval prompt. Newlines and tabs stay. Apply it where text is shown, and to anything stored for later.
 */
export function plainText(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(INVISIBLE, '')
}
