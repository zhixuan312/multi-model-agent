// v4.4.x — extracts structured findings from one read-route criterion
// turn. Worker emits `## Finding N:` blocks per the format spec; this
// parser converts them into StructuredReport.findings[] entries.

import type { FindingsOutcomeKind } from '../reporting/findings-outcome.js';

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

const SEVERITY_VALUES = new Set(['critical', 'high', 'medium', 'low']);

export function parseFindings(text: string, criterionId: string): FindingsParseResult {
  if (!text || text.trim().length === 0) {
    return { findings: [], outcome: 'clean' };
  }

  const blocks: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  for (const line of lines) {
    if (/^## Finding \d+:/.test(line)) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));

  const findings: Finding[] = [];
  for (const block of blocks) {
    // Extract the claim from the "- Claim:" bullet line within the block.
    // Note: the ## Finding N: heading line has no inline text (just the
    // heading + colon + newline); the actual claim lives in the bullet.
    // Claim can come from a `- Claim:` bullet (reviewer format) OR the inline
    // text on the `## Finding N: <text>` heading (legacy worker format).
    let claim = block.match(/^- Claim:\s*(.+)$/im)?.[1]?.trim() ?? '';
    if (!claim) {
      claim = block.match(/^## Finding \d+:\s*(.+)$/m)?.[1]?.trim() ?? '';
    }
    if (claim.startsWith('[N/A]')) continue;

    const sevRaw = block.match(/^- Severity:\s*(\w+)/im)?.[1]?.toLowerCase();
    const severity: Finding['severity'] = sevRaw && SEVERITY_VALUES.has(sevRaw)
      ? (sevRaw as Finding['severity'])
      : 'medium';
    const category = block.match(/^- Category:\s*(\S+)/im)?.[1] ?? criterionId;
    const evidence = block.match(/^- (?:Issue|Evidence):\s*(.+)$/im)?.[1]?.trim();
    const suggestion = block.match(/^- (?:Suggestion|Fix):\s*(.+)$/im)?.[1]?.trim();

    const f: Finding = { severity, category, claim };
    if (evidence) f.evidence = evidence;
    if (suggestion) f.suggestion = suggestion;
    findings.push(f);
  }

  // Extract outcome from ## Outcome section
  let outcome: FindingsOutcomeKind = findings.length > 0 ? 'found' : 'clean';

  // Check if ## Outcome section exists
  if (/^## Outcome/m.test(text)) {
    // Extract the value after the ## Outcome heading
    const outcomeMatch = text.match(/^## Outcome\s*\n\s*(\w*)/m);
    if (outcomeMatch) {
      const outcomeRaw = outcomeMatch[1].trim().toLowerCase();
      if (outcomeRaw === 'found' || outcomeRaw === 'clean' || outcomeRaw === 'not_applicable') {
        outcome = outcomeRaw as FindingsOutcomeKind;
      } else if (outcomeRaw === '') {
        // Empty outcome section → default to clean
        outcome = 'clean';
      }
    }
  }

  return { findings, outcome };
}
