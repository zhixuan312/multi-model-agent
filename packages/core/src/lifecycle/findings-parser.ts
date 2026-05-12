// v4.4.x — extracts structured findings from one read-route criterion
// turn. Worker emits `## Finding N:` blocks per the format spec; this
// parser converts them into StructuredReport.findings[] entries.

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  claim: string;
  evidence?: string;
  suggestion?: string;
}

const SEVERITY_VALUES = new Set(['critical', 'high', 'medium', 'low']);

export function parseFindings(text: string, criterionId: string): Finding[] {
  if (!text || text.trim().length === 0) return [];

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
    const headingMatch = block.match(/^## Finding \d+:\s*(.+)$/m);
    if (!headingMatch) continue;
    const claim = headingMatch[1].trim();
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
  return findings;
}
