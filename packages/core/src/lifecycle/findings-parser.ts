// v4.4.x — extracts structured findings from one read-route criterion
// turn. Worker emits `## Finding N:` blocks per the format spec; this
// parser converts them into StructuredReport.findings[] entries.
//
// Tolerant by design: LLMs vary heading level (## vs ###), heading noun
// (Finding/Issue/Concern), terminator (colon/period/none), bullet marker
// (- vs *), and bold wrapping (**Severity:**). Strict canonical format is
// preferred, but the parser recovers from common drift so a worker mistake
// becomes a degraded-but-usable result rather than silent data loss.

import type { FindingsOutcomeKind } from '../reporting/findings-outcome.js';

// `## Finding 1:` (canonical) plus tolerated drift:
//   - heading level 2–4 (##, ###, ####)
//   - noun: Finding | Issue | Concern (singular only; reviewers use "Concern")
//   - optional space, optional bold (**Finding 1:**)
//   - terminator: `:`, `.`, `)`, or end-of-line
// Uses [ \t]* (horizontal whitespace) so the regex doesn't cross newlines —
// `\s*` matches newlines and would let `(.*)` consume the following bullet line.
const FINDING_HEADING_RE = /^#{2,4}[ \t]*\**[ \t]*(?:Finding|Issue|Concern)[ \t]+(\d+)\**[ \t]*[:.)]?[ \t]*(.*)$/im;
// Same shape but per-line for the block-splitter (no /m needed when matched line-by-line).
const FINDING_HEADING_LINE_RE = /^#{2,4}[ \t]*\**[ \t]*(?:Finding|Issue|Concern)[ \t]+\d+\b/i;
// `- Severity: high` plus tolerated drift: * bullet, **bold:**, no bullet at all.
const bulletRe = (label: string) =>
  new RegExp(`^(?:[-*][ \\t]+)?\\**[ \\t]*${label}[ \\t]*\\**[ \\t]*:[ \\t]*(.+)$`, 'im');

export interface Finding {
  id?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  claim: string;
  evidence?: string;
  suggestion?: string;
  source?: 'implementer' | 'reviewer';
}

export interface FindingsParseResult {
  findings: Finding[];
  outcome: FindingsOutcomeKind;
}

type WarnSink = (event: string, data: Record<string, unknown>) => void;

const SEVERITY_VALUES = new Set(['critical', 'high', 'medium', 'low']);

export function parseFindings(
  text: string,
  criterionId: string,
  legalOutcomes: readonly FindingsOutcomeKind[] = ['found', 'clean', 'not_applicable'],
  warnSink: WarnSink = () => {},
): FindingsParseResult {
  if (!text || text.trim().length === 0) {
    return { findings: [], outcome: 'clean' };
  }

  const blocks: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  for (const line of lines) {
    if (FINDING_HEADING_LINE_RE.test(line)) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));

  const findings: Finding[] = [];
  for (const block of blocks) {
    const headingMatch = block.match(FINDING_HEADING_RE);
    const headingNum = headingMatch?.[1] ?? '?';
    const headingInline = headingMatch?.[2]?.trim() ?? '';
    const headingText = `Finding ${headingNum}: ${headingInline}`;

    // Claim can come from a `- Claim:` bullet (reviewer format) OR the inline
    // text on the heading line (legacy worker format).
    let claim = block.match(bulletRe('Claim'))?.[1]?.trim() ?? '';
    if (!claim) claim = headingInline;
    if (claim.startsWith('[N/A]')) continue;

    // A finding with no claim text at all is useless downstream — drop it
    // and surface a warning so the operator can spot worker-emission drift.
    if (!claim || claim.trim().length === 0) {
      warnSink('findings_parser_drop', {
        route: criterionId,
        droppedFindingHeading: headingText,
        reasonCode: 'empty_claim',
      });
      continue;
    }

    // Emit warning if claim is empty, but continue processing with empty claim
    if (!claim || claim.trim().length === 0) {
      warnSink('findings_parser_drop', {
        route: criterionId,
        droppedFindingHeading: headingText,
        reasonCode: 'empty_claim',
      });
      continue;
    }

    const sevRaw = block.match(bulletRe('Severity'))?.[1]?.trim().split(/\s+/)[0]?.toLowerCase();

    // Emit warning if Severity is missing, but continue with default
    if (!sevRaw) {
      warnSink('findings_parser_drop', {
        route: criterionId,
        droppedFindingHeading: headingText,
        reasonCode: 'missing_core_bullet',
      });
    }

    // Emit warning if Severity is invalid, but continue with default
    const severity: Finding['severity'] = (sevRaw && SEVERITY_VALUES.has(sevRaw))
      ? (sevRaw as Finding['severity'])
      : 'medium';
    if (sevRaw && !SEVERITY_VALUES.has(sevRaw)) {
      warnSink('findings_parser_drop', {
        route: criterionId,
        droppedFindingHeading: headingText,
        reasonCode: 'invalid_severity',
      });
    }

    const category = block.match(bulletRe('Category'))?.[1]?.trim().split(/\s+/)[0] ?? criterionId;
    const evidence = (block.match(bulletRe('Evidence'))?.[1] ?? block.match(bulletRe('Issue'))?.[1])?.trim();
    const suggestion = (block.match(bulletRe('Suggestion'))?.[1] ?? block.match(bulletRe('Fix'))?.[1])?.trim();

    // Drop for investigate routes if Evidence contains no file:line citation
    // ANYWHERE. Workers naturally write `In [src/foo.ts:42] the function …` or
    // wrap citations in markdown links — both forms now pass; only evidence
    // that is pure prose with no path:line gets dropped.
    if (criterionId.startsWith('investigate-') && evidence && !/[\w./-]+:\d+/.test(evidence)) {
      warnSink('findings_parser_drop', {
        route: criterionId,
        droppedFindingHeading: headingText,
        reasonCode: 'invalid_evidence_format',
      });
      continue;
    }

    const f: Finding = { severity, category, claim };
    if (evidence) f.evidence = evidence;
    if (suggestion) f.suggestion = suggestion;
    findings.push(f);
  }

  // Extract outcome. Canonical: `## Outcome\nfound`. Tolerated drift:
  //   `## Outcome: found` (inline), `### Outcome\nfound` (heading level),
  //   `**Outcome:** found` (bold bullet), `Outcome: found` (no heading).
  // Whichever form, value must be one of the legal-outcome enum literals.
  let outcome: FindingsOutcomeKind = findings.length > 0 ? 'found' : 'clean';
  // Horizontal-whitespace only on the heading line; newline before the value
  // on the next line is explicit. Three alternatives covered:
  //   1. `## Outcome\nfound` (heading + next-line value)
  //   2. `## Outcome: found` (heading + inline value)
  //   3. `Outcome: found` (bullet/bold/plain, no heading)
  const OUTCOME_LINE_RE = /^(?:#{2,4}[ \t]*\**[ \t]*Outcome\**[ \t]*[:.]?[ \t]*(\w*)[ \t]*\n[ \t]*(\w*)|(?:[-*][ \t]+)?\**[ \t]*Outcome[ \t]*\**[ \t]*:[ \t]*(\w+))/im;
  const m = text.match(OUTCOME_LINE_RE);
  if (m) {
    const raw = (m[1] || m[2] || m[3] || '').trim().toLowerCase();
    if (raw === 'found' || raw === 'clean' || raw === 'not_applicable') {
      outcome = raw as FindingsOutcomeKind;
    }
    // empty / unrecognized → keep the inferred outcome from findings.length
  }

  // Honor the route's legal-outcome set: if the worker declared a value that's
  // illegal for this criterion (e.g. 'not_applicable' on an issue-hunting
  // route), fall back to the inferred outcome rather than emit garbage.
  if (!legalOutcomes.includes(outcome)) {
    outcome = findings.length > 0 ? 'found' : (legalOutcomes[0] ?? 'clean');
  }

  return { findings, outcome };
}
