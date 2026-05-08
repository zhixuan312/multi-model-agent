import type { ReviewerVerdict, DiffReviewerVerdict } from './review-types.js';

export interface ReviewerParseResult {
  verdict: ReviewerVerdict;
  concerns: string[];
}

export interface ReviewerDiffParseResult {
  verdict: DiffReviewerVerdict;
  concerns: string[];
}

function extractSummarySection(text: string): string | null {
  const match = text.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  return match ? match[1].trim() : null;
}

/**
 * Extract the verdict from a JSON block in the reviewer's output.
 * Two acceptable shapes:
 *   1. Fenced: ```json {"verdict":"...","concerns":[...]} ```
 *   2. Bare:   {"verdict":"...","concerns":[...]}    (no fence)
 *
 * Some models freelance the format and skip the ```json``` wrapper —
 * the fenced-only parser would then drop a perfectly valid verdict
 * and fall through to the markdown-section path, which also fails
 * (since the JSON template doesn't emit `## Summary`), causing the
 * spurious "missing structured verdict" meta-concern that triggered
 * spec_rework spirals.
 *
 * Recognized verdict values (case-insensitive):
 *   - "approved" / "approve" → ReviewerVerdict.approved
 *   - "changes_required" / "changes-required" → changes_required
 *   - "concerns" → mapped to approved (parser convention: concerns
 *     ≠ blocking; use changes_required for blocking).
 */
function extractJsonVerdict(text: string): ReviewerVerdict | null {
  // Pass 1: fenced ```json ... ``` block.
  const fenced = text.match(/```json\s*\n([\s\S]*?)\n```/i);
  const fencedVerdict = fenced ? tryReadVerdict(fenced[1]) : null;
  if (fencedVerdict) return fencedVerdict;

  // Pass 2: scan for the first balanced `{...}` that parses as a JSON
  // object containing a "verdict" key. Pre-fix the parser only tried
  // FIRST `{` to LAST `}` — that fails when the text has prose with
  // its own `{...}` (e.g., "the diff matches {file} criteria...
  // {"verdict":"approved",...}"). We now walk each `{` left-to-right
  // and find its matching `}` via balanced-brace counting (string-
  // literal aware) so prose braces and JSON braces don't collide.
  return findFirstParseableJsonVerdict(text);
}

/**
 * Walk every `{` in `text` from left to right, find its balanced `}`
 * (respecting strings + escapes), and try to parse the slice as JSON
 * with a "verdict" field. Returns the first successful match, or null.
 */
function findFirstParseableJsonVerdict(text: string): ReviewerVerdict | null {
  const len = text.length;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start);
    if (end === -1) continue;
    const candidate = text.slice(start, end + 1);
    if (!/"verdict"\s*:/i.test(candidate)) continue;
    const v = tryReadVerdict(candidate);
    if (v) return v;
    // Bound the scan: don't try crazy-large prefixes from the same
    // position. matchingBrace already returns at most `len`.
    if (end >= len - 1) break;
  }
  return null;
}

/**
 * Return the index of the `}` that balances the `{` at `openPos`,
 * accounting for nested objects and string literals. Returns -1 when
 * unbalanced (don't try to parse).
 */
function matchingBrace(text: string, openPos: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openPos; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; continue; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readConcernsFromJsonText(text: string): string[] {
  const tryParse = (s: string): string[] => {
    try {
      const obj = JSON.parse(s) as { concerns?: unknown };
      if (Array.isArray(obj.concerns)) {
        return obj.concerns.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      /* not parseable */
    }
    return [];
  };
  const fenced = text.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (fenced) {
    const out = tryParse(fenced[1]);
    if (out.length > 0) return out;
  }
  // Bare JSON fallback — same balanced-brace walk as extractJsonVerdict
  // so the two helpers stay in sync. Pre-fix used a fragile first-`{`-
  // to-last-`}` slice that broke when prose contained `{}`.
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start);
    if (end === -1) continue;
    const candidate = text.slice(start, end + 1);
    if (!/"concerns"\s*:/i.test(candidate)) continue;
    const out = tryParse(candidate);
    if (out.length > 0) return out;
  }
  return [];
}

function tryReadVerdict(jsonText: string): ReviewerVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const obj = parsed as { verdict?: unknown };
  const v = typeof obj.verdict === 'string' ? obj.verdict.toLowerCase().trim() : '';
  if (v === 'approved' || v === 'approve') return 'approved';
  if (v === 'changes_required' || v === 'changes-required') return 'changes_required';
  if (v === 'concerns') return 'approved';
  return null;
}

function extractDeviationsAndUnresolved(text: string): string[] {
  const concerns: string[] = [];

  // Try fenced ```json``` first, then bare JSON (same lenient pattern
  // as extractJsonVerdict — keeps both helpers in sync so a parser
  // that recognizes the verdict also recognizes the concerns).
  const fromJson = readConcernsFromJsonText(text);
  concerns.push(...fromJson);

  const devMatch = text.match(/##\s*Deviations from brief\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (devMatch) {
    const lines = devMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
    concerns.push(...lines.map(l => l.replace(/^-\s*/, '').trim()));
  }

  const unresMatch = text.match(/##\s*Unresolved\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (unresMatch) {
    const lines = unresMatch[1].trim().split('\n').filter(l => l.trim().startsWith('-'));
    concerns.push(...lines.map(l => l.replace(/^-\s*/, '').trim()));
  }

  return concerns;
}

function extractDiffVerdict(text: string): DiffReviewerVerdict | null {
  const trimmed = text.trim();
  if (/^APPROVE\b/i.test(trimmed)) return 'approve';
  if (/^CONCERNS:/i.test(trimmed)) return 'concerns';
  if (/^REJECT:/i.test(trimmed)) return 'reject';
  return null;
}

export class ReviewerOutputParser {
  parse(text: string): ReviewerParseResult {
    // Source priority:
    //   1. JSON block ```json ... ``` containing {"verdict":"...","concerns":[...]}
    //      — what spec/quality templates actually instruct the LLM to emit
    //      (tool sweep #6 rewrite). The pre-fix parser only looked at
    //      `## Summary` markdown sections, defaulted every JSON-only
    //      response to `changes_required` with a meta-concern, and
    //      triggered exactly the spec_rework spirals we're trying to
    //      eliminate.
    //   2. `## Summary` markdown section (back-compat for any reviewer
    //      that still emits the older format).
    //   3. Fall through to changes_required with a meta-concern when
    //      neither path produced a verdict — keeps malformed output
    //      from crashing the run.
    const jsonVerdict = extractJsonVerdict(text);
    const concerns = extractDeviationsAndUnresolved(text);
    if (jsonVerdict) {
      return { verdict: jsonVerdict, concerns };
    }
    const summary = extractSummarySection(text);
    if (!summary) {
      return {
        verdict: 'changes_required',
        concerns: [
          'reviewer output missing structured verdict (no JSON block, no `## Summary` section) — defaulting to changes_required',
          ...concerns,
        ],
      };
    }
    const lower = summary.toLowerCase();
    const verdict: ReviewerVerdict = lower.includes('changes_required') ? 'changes_required' : 'approved';
    return { verdict, concerns };
  }

  parseDiff(text: string): ReviewerDiffParseResult {
    // Same leniency for diff review: missing verdict marker → concerns
    // (default conservative) plus a meta-concern. Don't crash the run.
    const verdict = extractDiffVerdict(text);
    const concerns = extractDeviationsAndUnresolved(text);
    if (!verdict) {
      return {
        verdict: 'concerns',
        concerns: [
          'diff reviewer output missing APPROVE / CONCERNS: / REJECT: marker — defaulting verdict to concerns',
          ...concerns,
        ],
      };
    }
    return { verdict, concerns };
  }
}

export class ReviewerParseError extends Error {
  constructor(message: string) { super(message); this.name = 'ReviewerParseError'; }
}
