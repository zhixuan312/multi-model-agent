// packages/core/src/reporting/report-parser-slots/research-report.ts
//
// v4.4.x: research joins the read-only family and produces `## Finding N:`
// blocks (parsed by the shared lifecycle/findings-parser.ts) + a research-
// specific `## Sources used` table at the end. This file owns ONLY the
// sources-table extractor; the canonical findings list comes from
// parseFindings. The Annotator handler merges both into the unified
// StructuredReport (route === 'research' gains the `sourcesUsed` field).
import type { ReportSchema } from '../structured-report-parser.js';
import { z } from 'zod';

const sourcesUsedZod = z.object({
  source: z.string(),
  attempted: z.boolean(),
  used: z.boolean(),
  note: z.string().optional(),
});

const researchReportZod = z.object({
  /** Research findings are surfaced via parseFindings (shared); this
   *  fallback parser leaves the field empty when the worker text could
   *  not be parsed. */
  findings: z.array(z.unknown()).default([]),
  sourcesUsed: z.array(sourcesUsedZod).default([]),
});

export type ResearchSourcesUsedEntry = z.infer<typeof sourcesUsedZod>;
export type ResearchReport = z.infer<typeof researchReportZod>;

/**
 * Parse the `## Sources used` markdown table from the implementer's text.
 * Tolerant: missing section → []; malformed rows skipped; case-insensitive
 * column-name matching.
 */
export function parseSourcesUsed(text: string): ResearchSourcesUsedEntry[] {
  const m = text.match(/##\s+Sources used\s*([\s\S]*?)(?:\n##\s|$)/i);
  if (!m) return [];
  const lines = m[1].split('\n').map(l => l.trim()).filter(Boolean);
  const rows: ResearchSourcesUsedEntry[] = [];
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

/** ReportSchema fallback consumed by the task-executor when the annotator
 *  did not produce a structured report. Returns the sources table; findings
 *  list is empty in this fallback path. */
export const researchReportSchema: ReportSchema<ResearchReport> = {
  parse(text: string): ResearchReport {
    return { findings: [], sourcesUsed: parseSourcesUsed(text) };
  },
};

/** @deprecated kept for back-compat with any caller still importing the
 *  pre-v4.4.x function name; the body is just `researchReportSchema.parse`. */
export function parseResearchReport(output: string): ResearchReport {
  return researchReportSchema.parse(output);
}
