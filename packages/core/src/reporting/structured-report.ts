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

  // Try ## headers first (standard format)
  const h2Parts = output.split(/(?=^##\s)/m);
  for (const part of h2Parts) {
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

  // Try # headers (h1) — only if h2 didn't already find summary
  // (so h1 can find it when both h1(h.summary) and h2(other sections) coexist)
  const h1Parts = output.split(/(?=^#\s)/m);
  for (const part of h1Parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('# ')) continue;
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) continue;
    const header = trimmed.slice(2, firstNewline).toLowerCase().trim();
    const content = trimmed.slice(firstNewline + 1).trim();
    if (header && content) {
      sections[header] = content.split('\n').map(l => l.trim()).filter(Boolean);
    }
  }

  if (Object.keys(sections).length > 0) return sections;

  // Try **Header** (bold) or Header: (colon) patterns
  const boldOrColonParts = output.split(/(?=^\*\*[A-Za-z]|^[A-Za-z][A-Za-z ]+:)/m);
  for (const part of boldOrColonParts) {
    const trimmed = part.trim();
    let header: string | undefined;
    let content: string | undefined;

    const boldMatch = trimmed.match(/^\*\*([^*]+)\*\*\s*\n([\s\S]+)/);
    if (boldMatch) {
      header = boldMatch[1].toLowerCase().trim();
      content = boldMatch[2].trim();
    }

    if (!header) {
      const colonMatch = trimmed.match(/^([A-Za-z][A-Za-z ]+):\s*(.+(?:\n[\s\S]*)?)/);
      if (colonMatch) {
        header = colonMatch[1].toLowerCase().trim();
        content = colonMatch[2].trim();
      }
    }

    if (header && content) {
      sections[header] = content.split('\n').map(l => l.trim()).filter(Boolean);
    }
  }

  if (Object.keys(sections).length > 0) return sections;

  // Last resort: treat first paragraph as implicit summary
  const firstParagraph = output.split(/\n\s*\n/)[0]?.trim();
  if (firstParagraph) {
    sections['summary'] = [firstParagraph];
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

