import {
  normalizeWhitespace,
  type AnnotatedFinding,
} from './findings-schema.js';

type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Map a worker-emitted severity string (case-insensitive, may be "mid")
 * to the canonical 4-tier value. Default 'medium' on unknown.
 */
function mapSeverity(raw: string): Severity {
  const s = raw.trim().toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'mid') return 'medium';
  if (s === 'low') return 'low';
  return 'medium';
}

/**
 * Match numbered/finding-shaped headings — broad enough to catch the most
 * common patterns workers actually produce. Two alternatives:
 *
 *   A. Markdown headings (Round-2 #5):
 *       "## 1. Title"           — h2 with number
 *       "### 2. Title"          — h3 with number
 *       "#### 3: Title"         — h4 with number+colon
 *       "### [4] Title"         — bracketed number
 *       "### Finding 5 — Title" — "Finding N" form
 *
 *   B. Bold-wrapped numbered headers (3.12.6 — what DeepSeek-as-implementer
 *      actually produces for audit narratives):
 *       "**1.**"                — bare bold-number on its own line, title-less;
 *                                 the body's "Issue:" line carries the claim
 *       "**Finding 2:** Title"  — bold "Finding N" with title
 *       "**[3]** Title"         — bold-bracketed number
 *
 * Plain `### Summary` / `### Performance Notes` and bare `**Severity:**`
 * tags are ignored on purpose so the fallback does not invent findings
 * out of structural sections or label lines.
 *
 * Capture group 1 is the bracketed number (when [N] form), 2 is the bare
 * number (otherwise). At least one is always set when this regex matches.
 * Group 3 is the title (may be empty for the bare bold-number form).
 */
// Note on whitespace: we use `[ \t]*` instead of `\s*` after the trailing
// `**` because `\s` matches `\n` in JS regex — that lets the title group
// `(.*)$` greedily eat the LINE BELOW the heading (which for audit findings
// is the `Severity:` label line) and produce a junk title. Restricting to
// horizontal whitespace keeps each heading bounded to its own line.
const SECTION_RE = /^(?:#{2,6}[ \t]+|\*\*[ \t]*)(?:Finding\s+)?(?:\[(\d+)\]|(\d+))(?:\*\*)?[ \t]*[\.\:\)\-\—\–]?(?:\*\*)?[ \t]*(.*)$/gim;
// Severity line — accepts optional Markdown-bullet prefixes (`-`, `*`, `+`)
// and optional bold wrappers, since 3.12.6 standardized the implementer
// prompt to emit findings as bulleted bodies (`- Severity: high`). Pre-3.12.6
// expected bare `Severity: ...` and quietly defaulted everything to medium
// when bullets were present — even though the implementer wrote real
// severities — producing dashboards that always showed "11 medium, 0 of
// anything else" for read-only audits.
const SEVERITY_RE = /^[ \t]*(?:[-*+][ \t]+)?\**[ \t]*Severity[ \t]*:[ \t]*\**[ \t]*(critical|high|medium|mid|low)\**[ \t]*$/gim;

interface RawSection {
  startIdx: number;
  endIdx: number;
  workerNumber: string;
  title: string;
}

/** Single-pass section iteration (Round-1 P3). */
function findSections(workerOutput: string): RawSection[] {
  const sections: RawSection[] = [];
  SECTION_RE.lastIndex = 0;
  let prev: { startIdx: number; workerNumber: string; title: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = SECTION_RE.exec(workerOutput)) !== null) {
    const startIdx = match.index;
    if (prev) {
      sections.push({ ...prev, endIdx: startIdx });
    }
    // capture[1] = [N] bracketed number; capture[2] = bare number; capture[3] = title.
    const workerNumber = match[1] ?? match[2] ?? '';
    prev = {
      startIdx,
      workerNumber,
      title: (match[3] ?? '').trim(),
    };
  }
  if (prev) sections.push({ ...prev, endIdx: workerOutput.length });
  return sections;
}

/**
 * Detect explicit "no findings" language so fallback returns [] instead of
 * a synthetic catch-all when a clean codebase produces a clean narrative
 * but the reviewer happens to fail JSON parse (Round-2 #6).
 */
const NO_FINDINGS_RE = /\b(?:no\s+(?:findings|issues|problems)\s+(?:found|detected|reported)?|nothing\s+to\s+report|0\s+findings|zero\s+findings)\b/i;

function severityFromSection(section: string): Severity {
  SEVERITY_RE.lastIndex = 0;
  const m = SEVERITY_RE.exec(section);
  if (!m) return 'medium';
  return mapSeverity(m[1]!);
}

/**
 * Build meaningful synthetic evidence (Round-1 #8):
 * - Prefer the section body (first 240 chars after the heading).
 * - If the body is too short, build a meaningful sentence from the title,
 *   not a space-padded string.
 *
 * Worker-stated number is preserved in the evidence prose, not in the id
 * (Round-1 #2 — ids must always be unique sequential).
 */
function buildEvidence(sectionText: string, title: string, workerNumber: string): string {
  const body = sectionText.split('\n').slice(1).join('\n').trim();
  if (body.length >= 20) return body.slice(0, 240);
  const synth = `Worker finding #${workerNumber} (${title}): no detailed body provided in implementer report.`;
  return synth.length >= 20 ? synth : `${synth} fallback-synthesized.`;
}

/**
 * Pull a one-line claim from labeled body lines when the section heading
 * itself carried no title (the bare `**N.**` form, common in DeepSeek
 * audit narratives). Falls back to empty string when no labeled line is
 * present — caller defaults to `Finding N` in that case.
 *
 * Recognized labels (case-insensitive): Issue, Title, Summary, Claim,
 * Description, Problem, Finding. Strips Markdown bold wrappers from
 * label and value. Truncates at 160 chars to keep dashboard rows readable.
 */
// Allow optional bullet prefixes (`-`, `*`, `+`) since 3.12.6 standardized
// the implementer prompt to emit labeled bullets (`- Issue: ...`). The
// optional `\**` captures bold-wrapped labels (`**Issue:**`).
const CLAIM_LABEL_RE = /^[ \t]*(?:[-*+][ \t]+)?\**[ \t]*(?:Issue|Title|Summary|Claim|Description|Problem|Finding)[ \t]*:?\**[ \t]*(.+?)[ \t]*$/im;
function claimFromBody(sectionText: string): string {
  const body = sectionText.split('\n').slice(1).join('\n');
  const m = CLAIM_LABEL_RE.exec(body);
  if (!m || !m[1]) return '';
  const raw = m[1].replace(/^\*+|\*+$/g, '').trim();
  return raw.length > 160 ? raw.slice(0, 157) + '...' : raw;
}

/**
 * Deterministic regex extractor — runs when the LLM reviewer's JSON output
 * fails parse twice. Synthesizes AnnotatedFinding[] so telemetry always has
 * something to count.
 *
 * Confidence is null. Ids are always sequential `F${i+1}` (never use the
 * worker's number — duplicates would violate annotatedFindingsSchema).
 * evidenceGrounded reflects the actual substring check on the normalized
 * worker output.
 *
 * If the worker output has zero parseable numbered sections and no explicit
 * "no findings" language, emits a single catch-all finding so downstream
 * telemetry never sees an empty list.
 */
export function fallbackExtractFindings(workerOutput: string): AnnotatedFinding[] {
  const normalizedWorker = normalizeWhitespace(workerOutput);
  const sections = findSections(workerOutput);

  // Round-2 #6: respect explicit "no findings" worker output.
  if (sections.length === 0 && NO_FINDINGS_RE.test(workerOutput)) {
    return [];
  }

  if (sections.length === 0) {
    const trimmed = workerOutput.trim();
    // Use real worker text when long enough — preserves evidenceGrounded=true.
    // Otherwise fall back to a meaningful synthetic sentence (knowingly ungrounded).
    const evidence = trimmed.length >= 20
      ? trimmed.slice(0, 240)
      : `Worker output had no parseable findings (length ${trimmed.length}). Fallback emitted catch-all so telemetry has at least one entry.`;
    const eNorm = normalizeWhitespace(evidence);
    return [{
      id: 'F1',
      severity: 'medium',
      claim: 'reviewer parse failed; deterministic fallback emitted single catch-all from worker output',
      evidence,
      annotatorConfidence: null,
      evidenceGrounded: eNorm.length >= 20 && normalizedWorker.includes(eNorm),
    }];
  }

  return sections.map((section, i) => {
    const sectionText = workerOutput.slice(section.startIdx, section.endIdx);
    const severity = severityFromSection(sectionText);
    const evidence = buildEvidence(sectionText, section.title, section.workerNumber);
    const eNorm = normalizeWhitespace(evidence);
    // 3.12.6: when the section heading was titleless (bare `**N.**` form),
    // try to derive the claim from a labeled body line (Issue: / Title: /
    // Summary: / etc.) so dashboard rows aren't all "Finding 1, Finding 2..."
    const derivedClaim = section.title || claimFromBody(sectionText) || `Finding ${i + 1}`;
    return {
      id: `F${i + 1}`,
      severity,
      claim: derivedClaim,
      evidence,
      annotatorConfidence: null,
      evidenceGrounded: eNorm.length >= 20 && normalizedWorker.includes(eNorm),
    };
  });
}
