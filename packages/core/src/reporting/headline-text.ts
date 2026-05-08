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

const SENTENCE_END = /^([^.!?\n]{1,80}[.!?])(\s|$)/;

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
  const m = trimmed.match(SENTENCE_END);
  if (m) return m[1];
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}
