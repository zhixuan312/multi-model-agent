// v4.4.x — intermediate contract between the worker (Implementing /
// Rework) and Annotating. Workers emit a JSON-fenced markdown block at
// the end of their final assistant text; parseWorkerOutput extracts the
// LAST block, parses it, and returns a normalized WorkerOutput.
//
// Three fallback branches keep Annotating non-crashing on imperfect
// worker output — see the design doc's "Parser contract" section.

import { z } from 'zod';

export const ValidationRunSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  output: z.string(),
});

export const WorkerOutputSchema = z.object({
  summary: z.string(),
  workerStatus: z.enum(['done', 'done_with_concerns', 'blocked', 'failed']),
  filesChanged: z.array(z.string()).default([]),
  validationsRun: z.array(ValidationRunSchema).default([]),
  unresolved: z.array(z.string()).default([]),
  commitMessage: z.string().optional(),
});

export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

const JSON_BLOCK_RE = /```json\n([\s\S]*?)\n```/g;

function findLastJsonBlock(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(JSON_BLOCK_RE)) last = m[1];
  return last;
}

function synthesizeFailed(summary: string, reason: string): WorkerOutput {
  return { summary, workerStatus: 'failed', filesChanged: [], validationsRun: [], unresolved: [reason] };
}

export function parseWorkerOutput(workerText: string): WorkerOutput {
  const block = findLastJsonBlock(workerText);
  if (!block) {
    const preview = workerText.trim().slice(0, 200) || '[empty]';
    return synthesizeFailed(preview, 'no structured output emitted');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return synthesizeFailed(workerText.trim().slice(0, 200) || '[empty]', `structured output not valid JSON: ${msg}`);
  }
  const parsed = WorkerOutputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // Schema-invalid: salvage what we can.
  const obj = (typeof raw === 'object' && raw !== null) ? (raw as Record<string, unknown>) : {};
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  const summaryStr = typeof obj.summary === 'string' && obj.summary.length > 0 ? obj.summary : '[empty]';
  const hasSummary = summaryStr !== '[empty]' && summaryStr.trim().length > 0;

  return {
    summary: summaryStr,
    workerStatus: hasSummary ? 'done_with_concerns' : 'failed',
    filesChanged: Array.isArray(obj.filesChanged)
      ? obj.filesChanged.filter((x): x is string => typeof x === 'string')
      : [],
    validationsRun: Array.isArray(obj.validationsRun)
      ? obj.validationsRun.filter(
          (v): v is { name: string; passed: boolean; output: string } =>
            v !== null && typeof v === 'object'
            && typeof (v as { name: unknown }).name === 'string'
            && typeof (v as { passed: unknown }).passed === 'boolean'
            && typeof (v as { output: unknown }).output === 'string',
        )
      : [],
    unresolved: [
      ...(Array.isArray(obj.unresolved) ? obj.unresolved.filter((x): x is string => typeof x === 'string') : []),
      `schema validation failed: ${issues.join('; ')}`,
    ],
    ...(typeof obj.commitMessage === 'string' && { commitMessage: obj.commitMessage }),
  };
}
