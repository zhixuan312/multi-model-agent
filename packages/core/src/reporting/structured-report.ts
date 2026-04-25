import { z } from 'zod';

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

If you wrote, modified, or deleted files, your structured report MUST include a \`commit:\` block as a JSON object with these fields:

  {
    "type": "feat" | "fix" | "refactor" | "test" | "docs" | "chore" | "style",
    "scope": "<optional, 1-24 chars: lowercase letters, digits, dot, underscore, slash, hyphen; must start with letter or digit>",
    "subject": "<1-50 chars, lowercase first letter, no trailing colon, no leading/trailing whitespace>",
    "body": "<optional multi-paragraph plain text explaining WHY>"
  }

Examples:
  type: "feat", scope: "core", subject: "add x"
  type: "refactor", scope: "run_tasks", subject: "extract Y from Z"
  type: "fix", subject: "guard against undefined"

Do NOT write narrative ("Now I'm going to...") in the subject. The runner will compose \`<type>(<scope>): <subject>\` as the commit message; your subject becomes the commit subject line verbatim.

If you did not write any files, omit the commit block entirely.
`.trim();

export const commitSchema = z.object({
  type: z.enum(['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'style']),
  scope: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,23}$/).optional(),
  subject: z.string()
    .min(1)
    .max(50)
    .refine(s => !/^[A-Z]/.test(s), 'subject must not start with ASCII uppercase')
    .refine(s => !s.endsWith(':'), 'subject must not end with colon')
    .refine(s => s === s.replace(/^\s+|\s+$/g, ''), 'no leading/trailing whitespace'),
  body: z.string().max(8192).optional(),
});

export type CommitFields = z.infer<typeof commitSchema>;

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
  commit?: CommitFields;
  commitDiagnostic?: string;
}

export type StructuredReport = ParsedStructuredReport;

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
  const report: ParsedStructuredReport = {
    summary: sections['summary']?.[0] ?? null,
    filesChanged: parseFilesChanged(sections['files changed']),
    validationsRun: parseValidationsRun(sections['validations run']),
    deviationsFromBrief: sections['deviations from brief'] ?? [],
    unresolved: sections['unresolved'] ?? [],
  };

  const commitMatch = output.match(/(?:^|\n)\s*commit:\s*({[\s\S]*?})\s*(?:\n|$)/);
  if (commitMatch) {
    try {
      const obj = JSON.parse(commitMatch[1]);
      const parsed = commitSchema.safeParse(obj);
      if (parsed.success) {
        report.commit = parsed.data;
      } else {
        report.commitDiagnostic = parsed.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
      }
    } catch (e) {
      report.commitDiagnostic = `commit block JSON parse error: ${(e as Error).message}`;
    }
  }

  return report;
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

function isLegitimatelyEmpty(lines: string[] | undefined): boolean {
  if (!lines || lines.length === 0) return true;
  // Strip optional bullet, lowercase, compare against the empty literals.
  const collapsed = lines
    .map(l => l.replace(/^[-*]\s*/, '').trim().toLowerCase())
    .filter(Boolean);
  if (collapsed.length === 0) return true;
  if (collapsed.length !== 1) return false;
  return collapsed[0] === '(none)' || collapsed[0] === 'none' || collapsed[0] === 'n/a';
}

function parseFilesChanged(lines: string[] | undefined): FileChange[] {
  if (isLegitimatelyEmpty(lines)) return [];
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
  if (isLegitimatelyEmpty(lines)) return [];
  return lines
    .map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const colonIdx = l.indexOf(':');
      if (colonIdx === -1) return { command: l, result: '' };
      return { command: l.slice(0, colonIdx).trim(), result: l.slice(colonIdx + 1).trim() };
    });
}

