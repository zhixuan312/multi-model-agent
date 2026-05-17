import { parseFindings } from '../lifecycle/findings-parser.js';

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

export function parseReviewReport(text: string): ParsedReviewReport {
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
  const result = parseFindings(findingsSection, 'reviewer');
  const findings = result.findings;

  // approved + findings → changes_required per design spec §4
  if (verdict === 'approved' && findings.length > 0) {
    verdict = 'changes_required';
  }

  return { verdict, findings };
}
