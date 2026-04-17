export const structuredReportSuffix = `
## Summary
One-line summary of what was done.

## Files changed
List of files modified, added, or deleted.

## Validations run
Checks performed to verify correctness (e.g., "tsc passes", "tests pass").

## Deviations from brief
Any intentional or unintentional deviations from the original brief.

## Unresolved
Open questions, incomplete items, or items requiring further investigation.
`.trim();

export interface FileChange {
  path: string;
  summary: string;
}

export interface ParsedStructuredReport {
  summary: string | null;
  filesChanged: FileChange[];
  validationsRun: Array<{ command: string; result: string }>;
  deviationsFromBrief: string[];
  unresolved: string[];
}

export function parseStructuredReport(output: string): ParsedStructuredReport {
  if (!output || !output.trim()) {
    return {
      summary: null,
      filesChanged: [],
      validationsRun: [],
      deviationsFromBrief: [],
      unresolved: [],
    };
  }

  const sections = extractSections(output);

  return {
    summary: sections['summary']?.[0] ?? null,
    filesChanged: parseFilesChanged(sections['files changed']),
    validationsRun: parseValidationsRun(sections['validations run']),
    deviationsFromBrief: sections['deviations from brief'] ?? [],
    unresolved: sections['unresolved'] ?? [],
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

function parseFilesChanged(lines: string[] | undefined): FileChange[] {
  if (!lines) return [];
  return lines
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const colonIdx = l.indexOf(':');
      if (colonIdx === -1) return { path: l, summary: '' };
      return { path: l.slice(0, colonIdx).trim(), summary: l.slice(colonIdx + 1).trim() };
    });
}

function parseValidationsRun(lines: string[] | undefined): Array<{ command: string; result: string }> {
  if (!lines) return [];
  return lines
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const colonIdx = l.indexOf(':');
      if (colonIdx === -1) return { command: l, result: '' };
      return { command: l.slice(0, colonIdx).trim(), result: l.slice(colonIdx + 1).trim() };
    });
}

