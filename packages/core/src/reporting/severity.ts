/**
 * Severity helpers shared across headline composers and telemetry
 * event-builder. Per the wire-telemetry-gaps plan (Gap 2 + round-2 F1):
 * THREE distinct helpers, NOT one — conflating headline counting with
 * telemetry bucketing would corrupt the wire's findings_critical /
 * findings_high columns.
 */

// canonical severity enum used across audit/review/verify/debug/investigate
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

const VALID = new Set<FindingSeverity>(['critical', 'high', 'medium', 'low']);

/**
 * Normalize a raw severity string to the canonical lowercase enum.
 * Returns null for unknown / unparseable values.
 *
 * Used by both headline counting and telemetry bucketing — single
 * source of truth for "what's the severity of this finding".
 */
export function normalizeSeverity(raw: unknown): FindingSeverity | null {
  if (typeof raw !== 'string') return null;
  const lc = raw.trim().toLowerCase() as FindingSeverity;
  return VALID.has(lc) ? lc : null;
}

/**
 * Headline-only helper. Counts findings whose normalized severity is
 * 'high' OR 'critical'. Used by audit + review headline composers to
 * surface the "(N high)" annotation.
 *
 * MUST NOT be used for telemetry bucketing — see
 * `bucketFindingsBySeverity` for that.
 */
export function countHighOrCritical(findings: ReadonlyArray<{ severity?: unknown }>): number {
  let n = 0;
  for (const f of findings) {
    const s = normalizeSeverity(f.severity);
    if (s === 'high' || s === 'critical') n += 1;
  }
  return n;
}

/**
 * Telemetry-only helper. Returns separate per-severity buckets:
 * `{ critical, high, medium, low }`. Used by event-builder so the
 * wire's findings_critical / findings_high / findings_medium /
 * findings_low DB columns each carry exact counts.
 *
 * MUST NOT be replaced by countHighOrCritical — that conflates
 * critical and high into one count.
 */
export function bucketFindingsBySeverity(
  findings: ReadonlyArray<{ severity?: unknown }>,
): Record<FindingSeverity, number> {
  const buckets: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const s = normalizeSeverity(f.severity);
    if (s) buckets[s] += 1;
  }
  return buckets;
}

/**
 * Extract findings from an implementer's narrative `## Finding N:` output
 * block-by-block. The audit / review / verify / debug / investigate
 * tool prompts instruct workers to emit findings in this exact format:
 *
 *     ## Finding 1: <title>
 *     - Severity: critical | high | medium | low
 *     - Location: file:line
 *     - Issue: ...
 *     - Suggestion: ...
 *
 * The annotator normally consumes that narrative and emits a structured
 * JSON array. When the annotator errors (parse failure, exhaustion
 * mid-block, etc.), this helper recovers the findings from the
 * implementer's output so the headline + envelope still report the
 * correct count. Returns one entry per finding with the parsed severity
 * (lowercase canonical, or null if no severity line was found).
 */
export function parseNarrativeFindings(
  output: string,
): Array<{ severity: FindingSeverity | null; claim: string }> {
  if (!output || typeof output !== 'string') return [];
  const findings: Array<{ severity: FindingSeverity | null; claim: string }> = [];
  // Split on `## Finding N:` headings (case-insensitive, lenient
  // whitespace + colon). Block 0 is everything BEFORE the first
  // heading — discard.
  const blocks = output.split(/^##\s+Finding\s+\d+\s*:?/im);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const titleMatch = block.match(/^[^\n]+/);
    const claim = titleMatch ? titleMatch[0].trim() : '';
    const sevMatch = block.match(/^\s*[-*]?\s*severity\s*:\s*(\w+)/im);
    const severity = sevMatch ? normalizeSeverity(sevMatch[1]) : null;
    findings.push({ severity, claim });
  }
  return findings;
}
