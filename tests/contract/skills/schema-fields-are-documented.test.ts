/**
 * A field a caller can send must be a field some skill documents.
 *
 * `includeHistory` is a live `journal_recall` input — `task-input-schema.ts` accepts it, the
 * preprocessor reads it, and `journal-adapter` uses it to include or exclude superseded nodes — and
 * it appeared in no skill doc anywhere. Its default `false` HIDES superseded learnings, so the one
 * question the journal exists to answer ("did we try this and drop it?") was answered wrongly by
 * default, with no documented switch.
 *
 * `deliverable` and `method` were undocumented too. `method` is on commonFields (all twelve types)
 * and selects committed Method guidance injected into both prompts; `deliverable` is wired onto
 * spec/plan/execute_plan/review and can 400 a request through
 * `validateDeliverableContractBoundary` — a rejection on a field no doc explains.
 *
 * The check is deliberately weak in one direction: it asks only that the field NAME appear
 * somewhere in the packaged skills, not that it be described well. That is enough to catch a field
 * nobody has written about at all, which is the failure here.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = 'packages/server/src/skills';
const SCHEMA = 'packages/core/src/unified/task-input-schema.ts';

/** Every skill doc plus the shared fragments, as one corpus. */
const skillText = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((e) =>
    readdirSync(join(SKILLS_DIR, e.name))
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(SKILLS_DIR, e.name, f), 'utf8')),
  )
  .join('\n');

/**
 * Caller-settable fields, read out of the schema source. Restricted to the ones declared with a
 * Zod type on their own line, which is how every request field in this file is written.
 */
function schemaFields(): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const names = new Set<string>();
  for (const [, name] of src.matchAll(/^\s{2,}(\w+):\s*z\.[a-zA-Z]/gm)) names.add(name!);
  return [...names];
}

/**
 * Fields that are structural rather than caller-facing: discriminators, nested shapes, and the
 * internal contract plumbing a caller never writes by hand.
 */
const NOT_CALLER_FACING = new Set([
  'type', 'paths', 'inline', 'root', 'path', 'id', 'criterion', 'method', 'why', 'kind',
  'locator', 'reason', 'digest', 'program', 'args', 'cwd', 'timeoutMs', 'state', 'audience',
  'disposition', 'artifacts', 'acceptance', 'references', 'command', 'contractApproval',
  'approvedBy', 'approvedAt', 'contractDigest', 'learning', 'prompt', 'topic',
]);

describe('every caller-settable schema field is documented somewhere', () => {
  const fields = schemaFields().filter((f) => !NOT_CALLER_FACING.has(f));

  it('finds fields to check', () => {
    expect(fields.length).toBeGreaterThan(5);
  });

  it.each(fields)('%s appears in the packaged skills', (field) => {
    expect(
      skillText.includes(field),
      `${field} is accepted by the request schema but no skill doc mentions it`,
    ).toBe(true);
  });
});
