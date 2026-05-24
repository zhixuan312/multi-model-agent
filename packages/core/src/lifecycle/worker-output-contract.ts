// v4.5 — intermediate contract between the worker (Implementing /
// Rework) and Annotating. Workers emit a JSON-fenced markdown block at
// the end of their final assistant text; parseWorkerOutput extracts the
// LAST block, parses it, and returns a normalized WorkerOutput.
//
// Three fallback branches keep Annotating non-crashing on imperfect
// worker output — see the design doc's "Parser contract" section.

import { z } from 'zod';

export const WorkerOutputSchema = z.object({
  workerSelfAssessment: z.enum(['done', 'failed']),
  summary: z.string(),
  // write-route fields (optional; default empty)
  filesChanged: z.array(z.string()).default([]),
  // read-route fields (optional; default empty)
  findings: z.array(z.unknown()).default([]),
  citations: z.array(z.unknown()).default([]),
  criteriaSucceeded: z.array(z.string()).default([]),
  criteriaErrors: z.array(z.object({ criterion: z.string(), error: z.string() })).default([]),
  sourcesUsed: z.array(z.string()).default([]),
});

export type WorkerOutput = z.infer<typeof WorkerOutputSchema> & {
  parsedCleanly: boolean;
};

const JSON_BLOCK_RE = /```json\n([\s\S]*?)\n```/g;

function findLastJsonBlock(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(JSON_BLOCK_RE)) last = m[1];
  return last;
}

export function parseWorkerOutput(workerText: string): WorkerOutput {
  const block = findLastJsonBlock(workerText);
  if (!block) {
    const preview = workerText.trim().slice(0, 2000) || '[empty]';
    return {
      workerSelfAssessment: 'failed' as const,
      summary: preview,
      filesChanged: [],
      findings: [],
      citations: [],
      criteriaSucceeded: [],
      criteriaErrors: [],
      sourcesUsed: [],
      parsedCleanly: false,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      workerSelfAssessment: 'failed' as const,
      summary: workerText.trim().slice(0, 2000) || '[empty]',
      filesChanged: [],
      findings: [],
      citations: [],
      criteriaSucceeded: [],
      criteriaErrors: [],
      sourcesUsed: [],
      parsedCleanly: false,
    };
  }
  const parsed = WorkerOutputSchema.safeParse(raw);
  if (parsed.success) return { ...parsed.data, parsedCleanly: true };

  // Schema-invalid but has summary: return failed with salvaged fields.
  const obj = (typeof raw === 'object' && raw !== null) ? (raw as Record<string, unknown>) : {};
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  const summaryStr = typeof obj.summary === 'string' && obj.summary.length > 0 ? obj.summary : workerText.trim().slice(0, 2000) || '[empty]';

  return {
    workerSelfAssessment: 'failed' as const,
    summary: summaryStr,
    filesChanged: Array.isArray(obj.filesChanged)
      ? obj.filesChanged.filter((x): x is string => typeof x === 'string')
      : [],
    findings: Array.isArray(obj.findings) ? obj.findings : [],
    citations: Array.isArray(obj.citations) ? obj.citations : [],
    criteriaSucceeded: Array.isArray(obj.criteriaSucceeded)
      ? obj.criteriaSucceeded.filter((x): x is string => typeof x === 'string')
      : [],
    criteriaErrors: Array.isArray(obj.criteriaErrors)
      ? obj.criteriaErrors.filter(
          (v): v is { criterion: string; error: string } =>
            v !== null && typeof v === 'object'
            && typeof (v as { criterion: unknown }).criterion === 'string'
            && typeof (v as { error: unknown }).error === 'string',
        )
      : [],
    sourcesUsed: Array.isArray(obj.sourcesUsed)
      ? obj.sourcesUsed.filter((x): x is string => typeof x === 'string')
      : [],
    parsedCleanly: false,
  };
}