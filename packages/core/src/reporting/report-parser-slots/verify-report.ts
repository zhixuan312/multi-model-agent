import type { ReportSchema } from '../structured-report-parser.js';

export interface VerifyReport {
  results: Array<{ item: string; pass: boolean; evidence: string }>;
}

/**
 * Extract verify checklist results from `## Finding N:` narrative blocks.
 *
 * The verify tool prompt instructs workers to emit results in this exact
 * format (and explicitly NOT JSON):
 *
 *     ## Finding 1: <title>
 *     - Severity: low|high|...
 *     - Item: <criterion text>
 *     - Result: PASS | FAIL
 *     - Evidence: <evidence>
 *
 * Returns one entry per finding block. `pass` is true iff the Result line
 * normalizes to "pass" (case-insensitive). Missing labels become empty
 * strings / false (matches the schema's required-field shape).
 */
export function parseVerifyResults(
  output: string,
): VerifyReport['results'] {
  if (!output || typeof output !== 'string') return [];
  const blocks = output.split(/^##\s+Finding\s+\d+\s*:?/im);
  const out: VerifyReport['results'] = [];
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const itemMatch = block.match(/^\s*[-*]?\s*Item\s*:\s*(.+?)\s*$/im);
    const resultMatch = block.match(/^\s*[-*]?\s*Result\s*:\s*(\w+)/im);
    const evidenceMatch = block.match(/^\s*[-*]?\s*Evidence\s*:\s*([\s\S]+?)(?=\n\s*[-*]\s|\n##|$)/im);
    const item = itemMatch ? itemMatch[1].trim() : '';
    const pass = resultMatch ? /^pass$/i.test(resultMatch[1].trim()) : false;
    const evidence = evidenceMatch ? evidenceMatch[1].trim() : '';
    out.push({ item, pass, evidence });
  }
  return out;
}

export const verifyReportSchema: ReportSchema<VerifyReport> = {
  parse(text: string) {
    // Primary path: JSON block (legacy; some workers may still emit it).
    const m = text.match(/```json\n([\s\S]+?)\n```/);
    if (m) return JSON.parse(m[1]);
    // Narrative path (the actual prompt format — the verify prompt
    // explicitly says "Do NOT emit JSON"). Recover one result per
    // `## Finding N:` block. If neither path produced anything,
    // throw so the parent falls back to notApplicable.
    const narrative = parseVerifyResults(text);
    if (narrative.length === 0) {
      throw new Error('verify report missing JSON block and no `## Finding N:` narrative results');
    }
    return { results: narrative };
  },
};
