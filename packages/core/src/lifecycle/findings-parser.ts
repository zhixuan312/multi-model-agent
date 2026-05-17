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
    // Extract heading for warning messages
    const headingMatch = block.match(/^## Finding \d+:[ \t]*(.*)$/m);
    const headingText = headingMatch ? `Finding ${headingMatch[0].match(/\d+/)?.[0]}: ${headingMatch[1]}` : '<missing-heading>';

    // Extract the claim from the "- Claim:" bullet line within the block.
    // Note: the ## Finding N: heading line has no inline text (just the
    // heading + colon + newline); the actual claim lives in the bullet.
    // Claim can come from a `- Claim:` bullet (reviewer format) OR the inline
    // text on the `## Finding N: <text>` heading (legacy worker format).
    let claim = block.match(/^- Claim:\s*(.+)$/im)?.[1]?.trim() ?? '';
    if (!claim) {
      claim = block.match(/^## Finding \d+:[ \t]*(.*)$/m)?.[1]?.trim() ?? '';
    }
    if (claim.startsWith('[N/A]')) continue;

    // Emit warning if claim is empty, but continue processing with empty claim
    if (!claim || claim.trim().length === 0) {
      warnSink('findings_parser_drop', {
        route: criterionId,
        droppedFindingHeading: headingText,
        reasonCode: 'empty_claim',
      });
      continue;
    }

    const sevRaw = block.match(/^- Severity:\s*(\w+)/im)?.[1]?.toLowerCase();

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

    const category = block.match(/^- Category:\s*(\S+)/im)?.[1] ?? criterionId;
    const evidence = block.match(/^- (?:Issue|Evidence):\s*(.+)$/im)?.[1]?.trim();
    const suggestion = block.match(/^- (?:Suggestion|Fix):\s*(.+)$/im)?.[1]?.trim();

    // Drop for investigate routes if Evidence doesn't start with file:line
    if (criterionId.startsWith('investigate-') && evidence && !evidence.match(/^[^:\s]+:\d+/)) {
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
