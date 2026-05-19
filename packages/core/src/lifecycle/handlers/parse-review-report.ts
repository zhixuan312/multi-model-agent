import { parseFindings } from '../findings-parser.js';
import type { FindingsOutcomeKind } from '../../reporting/findings-outcome.js';

export interface ParsedReviewReport {
  verdict: 'approved' | 'changes_required';
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string;
    claim: string;
    evidence?: string;
    suggestion?: string;
  }>;
}

const VERDICT_HEADER = /^##\s*verdict\s*$/im;
const FINDINGS_HEADER = /^##\s*findings\s*$/im;

type WarnSink = (event: string, data: Record<string, unknown>) => void;

export function parseReviewReport(
  text: string,
  legalOutcomes: readonly FindingsOutcomeKind[] = ['found', 'clean', 'not_applicable'],
  warnSink?: WarnSink,
): ParsedReviewReport {
  const safe = (text ?? '').toString();
  const verdictMatch = safe.match(VERDICT_HEADER);
  const findingsMatch = safe.match(FINDINGS_HEADER);

  let verdict: 'approved' | 'changes_required' = 'changes_required';
  if (verdictMatch) {
    const after = safe.slice(verdictMatch.index! + verdictMatch[0].length);
    const firstLine = after.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? '';
    if (/approved/i.test(firstLine) && !/changes/i.test(firstLine)) {
      verdict = 'approved';
    }
  } else if (/\bapproved\b/i.test(safe) && !/changes[\s_-]?required/i.test(safe)) {
    verdict = 'approved';
  }

  // Delegate finding extraction to the canonical parseFindings parser.
  // parseFindings is imported from lifecycle/findings-parser and handles the
  // ## Finding N: block format with severity/category/claim/evidence/suggestion.
  const findingsSection = findingsMatch
    ? safe.slice(findingsMatch.index! + findingsMatch[0].length)
    : '';
  const result = parseFindings(findingsSection, 'reviewer', legalOutcomes, warnSink);
  const findings = result.findings;

  // Severity-gated verdict override. The reviewer prompt is explicit that
  // "approved" means ship-able and that medium/low findings are nice-to-fix,
  // not blockers (see lifecycle/handlers/quality-review-prompt.ts:23-24). A blanket
  // "any finding flips approved → changes_required" rule contradicted that
  // contract and triggered a full rework cycle for a single low-severity
  // nit. Only critical/high findings are blockers, matching the ladder the
  // LLM was instructed to use.
  if (verdict === 'approved'
      && findings.some(f => f.severity === 'critical' || f.severity === 'high')) {
    verdict = 'changes_required';
  }

  return { verdict, findings };
}
