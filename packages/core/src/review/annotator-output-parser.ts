import type { AnnotatedFinding } from './review-types.js';

export interface AnnotatorParseResult {
  verdict: 'annotated' | 'error';
  annotatedFindings: AnnotatedFinding[];
  errorReason?: string;
}

/**
 * Tool sweep #12 follow-up: same lenient JSON-array extraction as
 * the reviewer-output-parser. Pre-fix this required a fenced
 * ```json ... ``` block. Some models emit:
 *   - Bare JSON arrays (no fence)
 *   - Fenced with no language tag (just ``` ... ```)
 *   - JSON arrays embedded in surrounding prose
 * — all of which were dropped, producing `verdict: 'error'` even when
 * the annotator did its job correctly. Caused verify's wire telemetry
 * to lose all PASS findings (annotated 0 instead of 4).
 *
 * Strategy: try fenced first (legacy), then fenced-without-language-tag,
 * then any balanced `[...]` containing finding-shaped objects in the
 * raw text. Same balanced-walking approach as findFirstParseableJsonVerdict
 * in reviewer-output-parser.ts.
 */
function extractFindingsArray(text: string): AnnotatedFinding[] | null {
  // Pass 1: ```json ... ``` (legacy).
  const fenced1 = text.match(/```json\s*\n([\s\S]*?)\n```/i);
  const r1 = fenced1 ? tryParseArray(fenced1[1]) : null;
  if (r1) return r1;
  // Pass 2: ``` ... ``` (no language tag) — some models drop the json hint.
  const fenced2 = text.match(/```\s*\n([\s\S]*?)\n```/);
  const r2 = fenced2 ? tryParseArray(fenced2[1]) : null;
  if (r2) return r2;
  // Pass 3: bare `[...]` array somewhere in the text. Walk every `[`
  // left-to-right, find its matching `]` via balanced bracket counting
  // (string-literal aware), try to parse each candidate.
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    const end = matchingBracket(text, start);
    if (end === -1) continue;
    const candidate = text.slice(start, end + 1);
    const r = tryParseArray(candidate);
    if (r) return r;
  }
  return null;
}

function tryParseArray(jsonText: string): AnnotatedFinding[] | null {
  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) return parsed as AnnotatedFinding[];
  } catch {
    /* not parseable */
  }
  return null;
}

/**
 * Return the index of the `]` that balances the `[` at `openPos`,
 * accounting for nested brackets and string literals.
 */
function matchingBracket(text: string, openPos: number): number {
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
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export class AnnotatorOutputParser {
  parse(input: { finalAssistantText: string | undefined; errorCode?: string }): AnnotatorParseResult {
    if (!input.finalAssistantText) {
      return { verdict: 'error', annotatedFindings: [], errorReason: input.errorCode ?? 'no output' };
    }
    const findings = extractFindingsArray(input.finalAssistantText);
    if (findings === null) {
      return { verdict: 'error', annotatedFindings: [], errorReason: 'no JSON array found in annotator output' };
    }
    return { verdict: 'annotated', annotatedFindings: findings };
  }
}
