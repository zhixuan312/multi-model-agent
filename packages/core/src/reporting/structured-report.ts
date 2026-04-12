export const structuredReportSuffix = `
## Summary
One-line summary of what was done.

## Files changed
List of files modified, added, or deleted.

## Normalization decisions
Any brief normalization decisions made during execution.

## Validations run
Checks performed to verify correctness (e.g., "tsc passes", "tests pass").

## Deviations from brief
Any intentional or unintentional deviations from the original brief.

## Unresolved
Open questions, incomplete items, or items requiring further investigation.
`.trim();

export interface ParsedStructuredReport {
  summary: string | null;
  filesChanged: string[];
  normalizationDecisions: string[][];
  validationsRun: string[];
  deviationsFromBrief: string | null;
  unresolved: string | null;
}

export function parseStructuredReport(output: string): ParsedStructuredReport {
  if (!output || !output.trim()) {
    return {
      summary: null,
      filesChanged: [],
      normalizationDecisions: [],
      validationsRun: [],
      deviationsFromBrief: null,
      unresolved: null,
    };
  }

  const sections = extractSections(output);

  return {
    summary: sections['summary']?.[0] ?? null,
    filesChanged: parseListSection(sections['files changed']),
    normalizationDecisions: parseNormalizationDecisions(sections['normalization decisions']),
    validationsRun: parseListSection(sections['validations run']),
    deviationsFromBrief: sections['deviations from brief']?.[0] ?? null,
    unresolved: sections['unresolved']?.[0] ?? null,
  };
}

function extractSections(output: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  const parts = output.split(/(?=^##\s)/m);
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('## ')) continue;
    
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) continue;
    
    const header = trimmed.slice(3, firstNewline).toLowerCase().trim();
    const content = trimmed.slice(firstNewline + 1).trim();
    
    if (header && content) {
      sections[header] = content.split('\n').map(l => l.trim()).filter(Boolean);
    }
  }

  return sections;
}

function parseListSection(lines: string[] | undefined): string[] {
  if (!lines) return [];
  return lines
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l && !l.startsWith('#'));
}

function parseNormalizationDecisions(lines: string[] | undefined): string[][] {
  if (!lines) return [];
  return lines
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l.includes('→'))
    .map(l => [l]);
}
