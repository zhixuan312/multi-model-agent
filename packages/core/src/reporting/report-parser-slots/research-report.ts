// packages/core/src/reporting/report-parser-slots/research-report.ts
import { z } from 'zod';

export const researchReportSchema = z.object({
  findings: z.array(z.object({
    index: z.number().int().nonnegative(),
    body: z.string(),
    citations: z.array(z.object({
      kind: z.enum(['url', 'file_line', 'source']),
      label: z.string().optional(),
      target: z.string().optional(),
    })),
  })),
  sourcesUsed: z.array(z.object({
    source: z.string(),
    attempted: z.boolean(),
    used: z.boolean(),
    note: z.string().optional(),
  })),
});
export type ResearchReport = z.infer<typeof researchReportSchema>;

const NUMBERED_FINDING_RE = /^\s*(\d+)\.\s+([\s\S]*?)(?=^\s*\d+\.\s+|\n##\s|\n#\s|$)/gmu;
const URL_RE = /https?:\/\/[^\s)]+/g;
const FILE_LINE_RE = /([A-Za-z0-9_./-]+):(\d+(?:-\d+)?)/g;

interface SourcesRow { source: string; attempted: boolean; used: boolean; note?: string; }

function parseSourcesUsed(text: string): SourcesRow[] {
  const m = text.match(/##\s+Sources used\s*([\s\S]*?)(?:\n##\s|$)/i);
  if (!m) return [];
  const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean);
  const rows: SourcesRow[] = [];
  for (const line of lines) {
    if (!line.startsWith('|') || /^\|\s*-/.test(line) || /^\|\s*source\s*\|/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 3) continue;
    const [source, attemptedRaw, usedRaw, note] = cells;
    rows.push({
      source,
      attempted: /^yes$/i.test(attemptedRaw),
      used: /^yes$/i.test(usedRaw),
      ...(note ? { note } : {}),
    });
  }
  return rows;
}

function extractCitations(body: string, sources: SourcesRow[]): ResearchReport['findings'][0]['citations'] {
  const citations: ResearchReport['findings'][0]['citations'] = [];
  for (const m of body.matchAll(URL_RE)) {
    citations.push({ kind: 'url', label: extractDomain(m[0]), target: m[0] });
  }
  for (const m of body.matchAll(FILE_LINE_RE)) {
    if (URL_RE.test(m[0])) continue; // skip if it's part of a URL
    citations.push({ kind: 'file_line', label: m[1], target: `${m[1]}:${m[2]}` });
  }
  // Pass 2: source-name match against the Sources Used table.
  const lower = body.toLowerCase();
  for (const row of sources) {
    if (lower.includes(row.source.toLowerCase())) {
      citations.push({ kind: 'source', label: row.source });
    }
  }
  return citations;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function parseResearchReport(output: string): ResearchReport {
  const sourcesUsed = parseSourcesUsed(output);
  const findings: ResearchReport['findings'] = [];
  for (const m of output.matchAll(NUMBERED_FINDING_RE)) {
    const idx = Number(m[1]);
    const body = m[2].trim();
    if (!body) continue;
    findings.push({
      index: idx,
      body,
      citations: extractCitations(body, sourcesUsed),
    });
  }
  return { findings, sourcesUsed };
}
