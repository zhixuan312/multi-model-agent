import type { RunResult } from '../types.js';
import type { ParsedStructuredReport } from '../reporting/structured-report.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import fs from 'fs/promises';

export async function readImplementerFileContents(
  filesWritten: string[],
  cwd: string | undefined,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  const basePath = cwd ?? process.cwd();
  for (const filePath of filesWritten) {
    try {
      const resolved = filePath.startsWith('/') ? filePath : `${basePath}/${filePath}`;
      const content = await fs.readFile(resolved, 'utf-8');
      contents[filePath] = content.length > 50_000
        ? content.slice(0, 50_000) + '\n[truncated at 50KB]'
        : content;
    } catch {
      contents[filePath] = '[file not readable]';
    }
  }
  return contents;
}

export function buildFallbackImplReport(result: RunResult): ParsedStructuredReport {
  const parsed = parseStructuredReport(result.output);
  if (parsed.summary) {
    return parsed;
  }
  return {
    summary: result.output.substring(0, 200),
    filesChanged: result.filesWritten.map(f => ({ path: f, summary: 'updated' })),
    validationsRun: [],
    deviationsFromBrief: [],
    unresolved: [],
    extraSections: {},
  };
}
