import { readFile } from 'node:fs/promises';
import { REFINER_SCHEMAS } from '../../../packages/core/src/unified/refiner-schemas.js';

/**
 * Bind each reviewer skill's DOCUMENTED output shape to the schema that validates it.
 *
 * Regression: `execute_plan`'s refiner schema moved to a stable `id` (title became
 * optional, because a reworded echo was indistinguishable from unfinished work), but
 * `skills/execute_plan/review.md` still showed `{"title": …, "status": …}` with no `id`
 * at all. The reviewer dutifully emitted what the skill asked for, so EVERY run failed
 * schema validation with `reviewer_unavailable` and fell through to
 * `contract_unverifiable` — the id matcher could never match, because nothing told the
 * reviewer to produce ids.
 *
 * That is the same generator/validator boundary that caused the original completion-gate
 * bug: the validator moved and its generator didn't. A skill is a generator of model
 * output, so it needs the same round-trip check as any other producer — asserting the
 * example in the prose actually satisfies the schema.
 */
/**
 * Read a skill's documented JSON example, normalising the notation these examples use
 * for humans: `"done|failed"` shows a CHOICE and `"<task id>"` shows a slot. Both are
 * valid JSON strings but neither is a valid instance, so collapse them to a concrete
 * value first. Structure and required keys — what this test is actually about — survive
 * the substitution untouched.
 */
async function firstJsonBlock(skillPath: string): Promise<unknown> {
  const md = await readFile(skillPath, 'utf8');
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(md);
  if (!match) throw new Error(`no \`\`\`json block found in ${skillPath}`);
  const concrete = match[1]!
    .replace(/"([a-z_]+(?:\|[a-z_]+)+)"/g, (_all, choices: string) => `"${choices.split('|')[0]}"`)
    .replace(/"<[^">]*>"/g, '"placeholder"');
  return JSON.parse(concrete);
}

describe('contract: reviewer skill output examples satisfy their refiner schema', () => {
  it('execute_plan review.md documents an id-bearing shape the schema accepts', async () => {
    const example = await firstJsonBlock('packages/core/src/skills/execute_plan/review.md');
    const parsed = REFINER_SCHEMAS.execute_plan!.safeParse(example);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('execute_plan review.md names `id` explicitly as required', async () => {
    const md = await readFile('packages/core/src/skills/execute_plan/review.md', 'utf8');
    // The reviewer must be told to emit the id, not merely permitted to.
    expect(md).toMatch(/`id`\s+is\s+REQUIRED/i);
    // And it must not present a title-only shape as the output contract.
    const jsonBlock = /```json\s*\n([\s\S]*?)\n```/.exec(md)?.[1] ?? '';
    expect(jsonBlock).toContain('"id"');
  });

  it('the schema still treats title as optional, so a reworded echo cannot fail a run', () => {
    const idOnly = { tasks: [{ id: 'I-1', status: 'done' }], notes: '' };
    expect(REFINER_SCHEMAS.execute_plan!.safeParse(idOnly).success).toBe(true);

    // …and a title-only report (the pre-fix shape) must NOT validate, since that is
    // precisely the silent failure this test exists to prevent regressing to.
    const titleOnly = { tasks: [{ title: 'Task I-1: whatever', status: 'done' }], notes: '' };
    expect(REFINER_SCHEMAS.execute_plan!.safeParse(titleOnly).success).toBe(false);
  });
});
