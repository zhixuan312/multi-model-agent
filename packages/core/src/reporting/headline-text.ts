/**
 * Helpers for headline text shaping.
 *
 * Headlines are operator-facing single-line strings that appear in
 * polling output and the terminal envelope. They MUST stay short and
 * structured — workers' free-form `summary` fields can be paragraphs
 * long and end mid-sentence (the v4.0.3 Gap 12 case: "...now ends
 * with:" cut off because the worker meant to put a code excerpt
 * after the colon).
 *
 * `firstSentenceOrTruncate` is the single helper composers use to
 * sanitize narrative text for headline display.
 */

/**
 * Return the first sentence of `s`, or a hard-truncated form with
 * trailing ellipsis when no sentence boundary exists in the first
 * `max` characters.
 *
 * Why first-sentence? Worker summaries follow a "headline sentence,
 * then details" pattern; the first sentence carries the operator-
 * relevant signal. Truncating mid-sentence (the prior bug) loses
 * that signal AND looks broken.
 *
 * Sentence-end heuristic: a `.!?` followed by whitespace OR end-of-
 * string. The match is non-greedy and ranges over `max` characters,
 * so internal punctuation (version numbers like `v4.0.3`, decimals
 * like `1.5`, filenames like `auth.ts`) does NOT block the scan.
 *
 * @param s     raw text (may be empty / whitespace-only)
 * @param max   hard truncation cap when no sentence break is found.
 *              80 keeps headlines well under the typical 120-char
 *              terminal-line target after the bracket prefix +
 *              file-count suffix are added.
 */
export function firstSentenceOrTruncate(s: string, max = 80): string {
  if (!s || typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (trimmed.length === 0) return '';

  // F2 fix (audit, low): defend against invalid `max` values. Headlines
  // are single-line operator-facing strings; a buggy caller passing
  // `max=0`, negative, `NaN`, or `Infinity` shouldn't make the regex
  // throw or overrun. Coerce to a sane bound: integer in [1, 2000].
  const safeMax =
    Number.isFinite(max) && max >= 1
      ? Math.min(Math.floor(max), 2000)
      : 80;

  // N2 fix (audit-2, low): collapse whitespace BEFORE sentence detection.
  // Doing it after meant a sentence wrapping across a newline before
  // its terminator (e.g., "Fixed auth\nissue. More") never matched the
  // boundary regex and fell through to a generic truncate.
  const oneLine = collapseNewlines(trimmed);

  // N1 fix (audit-2, low): cap the captured sentence at exactly `safeMax`
  // chars including the terminating punctuation. The leading run is
  // therefore at most `safeMax - 1` chars. Skip sentence detection
  // entirely when there's no room for even "X." (safeMax < 2).
  // Lazy quantifier `{1,N}?` lets internal `.!?` characters pass
  // through (version numbers, decimals, filenames) until we hit one
  // followed by whitespace or end-of-string — the real sentence boundary.
  if (safeMax >= 2) {
    const sentenceEnd = new RegExp(`^(.{1,${safeMax - 1}}?[.!?])(\\s|$)`);
    const m = oneLine.match(sentenceEnd);
    if (m) return m[1];
  }

  return oneLine.length > safeMax ? oneLine.slice(0, safeMax - 1) + '…' : oneLine;
}

/** Replace any whitespace run (including newlines, tabs, and CRs) with
 *  a single space so the returned headline stays on one line. */
function collapseNewlines(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
