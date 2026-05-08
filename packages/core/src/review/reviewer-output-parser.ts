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

  // Pass 2: first bare JSON object containing a "verdict" key. Use a
  // greedy {...} match anchored on the first `{` that begins a JSON
  // object — short responses often contain ONLY the JSON, no prose.
  // We try progressively-larger candidate slices to handle nested
  // objects in the concerns array.
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;
  // Try the trailing slice from each candidate `}` going leftward (the
  // outermost JSON object's closing brace is the rightmost `}` after
  // firstBrace). Bounded scan keeps this O(N).
  for (let end = text.lastIndexOf('}'); end > firstBrace; end = text.lastIndexOf('}', end - 1)) {
    const candidate = text.slice(firstBrace, end + 1);
    if (!/"verdict"\s*:/i.test(candidate)) continue;
    const verdict = tryReadVerdict(candidate);
    if (verdict) return verdict;
  }
  return null;
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
  // Bare JSON fallback (matches extractJsonVerdict's logic).
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return [];
  for (let end = text.lastIndexOf('}'); end > firstBrace; end = text.lastIndexOf('}', end - 1)) {
    const candidate = text.slice(firstBrace, end + 1);
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
