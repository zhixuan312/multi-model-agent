import {
  reviewerEmittedFindingsSchema,
  normalizeWhitespace,
  type AnnotatedFinding,
} from './findings-schema.js';
import { classifyConcern } from '../events/concern-classifier.js';

interface ParseOk {
  ok: true;
  findings: AnnotatedFinding[];
  /** Findings whose evidence was NOT a substring of worker output — kept but flagged. */
  ungroundedCount: number;
}
interface ParseErr {
  ok: false;
  reason: string;
}
export type ParseReviewerFindingsResult = ParseOk | ParseErr;

// Permissive fence regex (Round-3 #2): case-insensitive `json`, allow:
//   - any whitespace (including none) between opening fence and content
//   - any whitespace (including none) between content and closing fence
//     so compact "[]```" or content-on-one-line forms are accepted.
// The captured group is JSON-trimmed before parse.
const JSON_BLOCK_RE = /```json[ \t]*\r?\n?([\s\S]*?)\s*```[ \t]*/gi;

/**
 * Extract the LAST `` ```json `` fenced code block from the reviewer output.
 * Reviewers often emit example/format JSON earlier; the real findings array
 * is conventionally last. Single-pass — does not materialize all matches.
 */
function extractFinalJsonBlock(output: string): string | null {
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  // Reset lastIndex on the shared regex to make this re-entrant.
  JSON_BLOCK_RE.lastIndex = 0;
  while ((match = JSON_BLOCK_RE.exec(output)) !== null) {
    last = match;
  }
  return last ? last[1] ?? null : null;
}

/**
 * Substring check against a pre-normalized worker output. Avoids re-normalizing
 * the (potentially large) worker output for every finding (Round-1 P2).
 */
function evidenceIsGroundedAgainst(evidence: string, normalizedWorker: string): boolean {
  const e = normalizeWhitespace(evidence);
  if (e.length < 20) return false;
  return normalizedWorker.includes(e);
}

/**
 * Parse the reviewer's structured output and annotate each finding with
 * `evidenceGrounded`.
 *
 * Pipeline:
 * 1. Extract the final `` ```json `` block (permissive fence).
 * 2. JSON.parse + Zod-validate against reviewerEmittedFindingsSchema.
 * 3. Normalize worker output ONCE; for each finding set
 *    `evidenceGrounded` against the normalized worker.
 * 4. Return ALL findings — never drop. `ungroundedCount` is informational only.
 */
export function parseReviewerFindings(
  reviewerOutput: string,
  workerOutput: string,
): ParseReviewerFindingsResult {
  const block = extractFinalJsonBlock(reviewerOutput);
  if (block === null) {
    return { ok: false, reason: 'reviewer output missing ```json fenced block' };
  }
  let parsed: unknown;
  try {
    // Trim — the permissive regex can capture leading/trailing whitespace.
    parsed = JSON.parse(block.trim());
  } catch (err) {
    return { ok: false, reason: `reviewer JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const validated = reviewerEmittedFindingsSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: `findings array validation failed: ${validated.error.message}` };
  }
  // Round-2 P2: fuse map + count to avoid the second pass.
  const normalizedWorker = normalizeWhitespace(workerOutput);
  const annotated: AnnotatedFinding[] = [];
  let ungroundedCount = 0;
  for (const f of validated.data) {
    const grounded = evidenceIsGroundedAgainst(f.evidence, normalizedWorker);
    if (!grounded) ungroundedCount++;
    // Prefer reviewer-emitted category; fall back to deterministic regex
    // classification over the claim. classifyConcern only reads `.message`
    // (concern-classifier.ts:34) — `source`/`severity` are ignored but
    // required by the parameter shape.
    const category =
      f.category
      ?? classifyConcern({ source: 'quality_review', severity: f.severity, message: f.claim });
    annotated.push({ ...f, evidenceGrounded: grounded, category });
  }
  return { ok: true, findings: annotated, ungroundedCount };
}
