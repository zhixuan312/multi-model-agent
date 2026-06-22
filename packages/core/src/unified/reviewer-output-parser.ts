import { REFINER_SCHEMAS } from './refiner-schemas.js';
import type { TaskType } from './type-registry.js';

export type ParseResult = { ok: true; data: unknown } | { ok: false; error: string; raw: string };

export function parseReviewerOutput(raw: string, taskType: TaskType): ParseResult {
  const json = extractJson(raw);
  if (!json) return { ok: false, error: 'No JSON found in reviewer output', raw };

  const parsed = tryParse(json);
  if (parsed === undefined) return { ok: false, error: 'Invalid JSON in reviewer output', raw };

  const schema = REFINER_SCHEMAS[taskType];
  if (!schema) {
    return { ok: true, data: parsed };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) return { ok: false, error: `Schema: ${result.error.message}`, raw };

  return { ok: true, data: result.data };
}

function tryParse(json: string): unknown | undefined {
  try { return JSON.parse(json); }
  catch { /* fall through to recovery */ }

  let trimmed = json;
  for (let i = 0; i < 3; i++) {
    trimmed = trimmed.replace(/\}\s*$/, '');
    try { return JSON.parse(trimmed + '}'); }
    catch { /* try next */ }
  }
  return undefined;
}

function extractJson(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  if (fenced.length) return fenced[fenced.length - 1][1]!.trim();
  const bare = text.match(/\{[\s\S]*\}/);
  if (bare) return bare[0]!.trim();
  return null;
}
