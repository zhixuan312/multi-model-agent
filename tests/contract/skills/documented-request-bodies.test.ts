/**
 * Every request body a packaged doc shows must be one the request schema accepts.
 *
 * `/mma-breakout`'s close-out — the whole point of the command — told the agent to dispatch
 * "one `journal_record` task with the full confirmed batch and one shared `topic` value". No
 * such body exists: `topic` is per-record, the canonical schema is `.strict()`, and the legacy
 * normalizer deliberately leaves a body carrying BOTH `records` and a top-level `topic`
 * untouched so the ambiguous mixed shape is rejected. Following the instruction produced
 * `400 invalid_request` on every breakout close-out, and nothing caught it: the instruction was
 * prose, the schema was TypeScript, and no test ran one through the other.
 *
 * Two halves, because the bug had two halves. The fix replaced that sentence with a fenced
 * example, so the general guard here parses EVERY documented request body in the packaged trees
 * against the real schema — a body can no longer be wrong. Prose still can, which is why the
 * last test pins the specific sentence: an instruction that only ever existed as prose is only
 * ever catchable as prose.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskInputSchema } from '../../../packages/core/src/unified/task-input-schema.js';

const ROOTS = ['packages/server/src/skills', 'plugin/skills', 'plugin/commands'];

function markdownFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? markdownFiles(join(root, entry.name)) : entry.name.endsWith('.md') ? [join(root, entry.name)] : [],
  );
}

/** A documented body, unwrapped from the `{ cwd, request }` envelope when it uses one. */
function requestBodies(text: string): unknown[] {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((match) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]!);
    } catch {
      return []; // Illustrative fragments with `...` are not request bodies.
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const value = parsed as Record<string, unknown>;
    const body = 'request' in value ? value.request : value;
    if (!body || typeof body !== 'object') return [];
    const fields = body as Record<string, unknown>;
    // Only bodies claiming a task type — error shapes have no `type` at all…
    if (typeof fields.type !== 'string') return [];
    // …and a RESPONSE envelope has one that names the route it answered, next to fields no
    // request carries. `type: "<route>"` there is a placeholder, not a discriminator.
    if ('executionId' in fields || 'execution' in fields || 'metrics' in fields) return [];
    return [body];
  });
}

describe('contract: documented request bodies are valid requests', () => {
  const documented = ROOTS.flatMap((root) =>
    markdownFiles(root).flatMap((file) => requestBodies(readFileSync(file, 'utf8')).map((body) => ({ file, body }))),
  );

  it('finds request bodies to check', () => {
    // A refactor that stops matching the fences would otherwise make this file vacuously green.
    expect(documented.length).toBeGreaterThan(10);
  });

  it.each(documented.map((d, i) => ({ ...d, i })))('$file body #$i parses', ({ file, body }) => {
    const result = taskInputSchema.safeParse(body);
    expect(
      result.success,
      `${file}: ${result.success ? '' : JSON.stringify(result.error.issues)}`,
    ).toBe(true);
  });

  it('mma-breakout no longer instructs a shared top-level topic alongside records', () => {
    for (const file of ['packages/server/src/skills/mma-breakout/SKILL.md', 'plugin/commands/breakout.md']) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/shared `topic` value/);
      expect(text, file).toContain('`records[]`');
    }
  });
});
