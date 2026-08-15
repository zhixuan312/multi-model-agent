import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TASK_TYPES, TYPE_REGISTRY, type TaskType } from '../../../packages/core/src/unified/type-registry.js';

const SKILLS_ROOT = 'packages/core/src/skills';

/** The exact sentence every reader-facing reviewer must carry, once. */
const APPROVED = "Don't rephrase text that is already correct and already follows the writing style above.";

/**
 * Earlier phrasings of the same instruction. None may survive anywhere — including in review
 * skills that do NOT carry the approved sentence.
 */
const LEGACY = [
  "Don't rephrase correct text for style.",
  "Don't rephrase for style.",
  "Don't rephrase correct findings for style.",
];

/**
 * The reader-facing types whose reviewer carries the approved guard.
 *
 * DERIVED from `TYPE_REGISTRY.readerFacing` rather than hand-listed. The previous version named
 * seven files directly, which is a snapshot of what someone remembered: it missed `spec` and
 * `plan` (both reader-facing), and it missed that `delegate/review.md` still carried one of the
 * legacy phrasings it bans — because delegate was not on the list.
 *
 * `spec` and `plan` are reader-facing and deliberately absent below: their reviewers REWRITE the
 * document by design, and neither has ever carried the guard. Listing them here as exceptions
 * makes that a recorded decision instead of an omission — and the exact-set assertion means
 * adding the guard to either one fails until this list is updated.
 */
const WITHOUT_GUARD = new Set<TaskType>(['spec', 'plan']);

async function reviewSkillPaths(): Promise<Array<{ type: string; path: string }>> {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ type: entry.name, path: `${SKILLS_ROOT}/${entry.name}/review.md` }));
}

describe('reviewer writing-style wording', () => {
  it('carries the approved guard exactly once in every reader-facing reviewer that declares it', async () => {
    const expected = TASK_TYPES.filter((type) => TYPE_REGISTRY[type].readerFacing && !WITHOUT_GUARD.has(type));
    expect(expected.length, 'the reader-facing set should not be empty').toBeGreaterThan(0);

    for (const type of expected) {
      const source = await readFile(`${SKILLS_ROOT}/${type}/review.md`, 'utf8');
      expect(source.split(APPROVED).length - 1, `${type}/review.md`).toBe(1);
    }
  });

  it('carries it in NO other review skill, so the exception list stays honest', async () => {
    const expected = new Set(TASK_TYPES.filter((type) => TYPE_REGISTRY[type].readerFacing && !WITHOUT_GUARD.has(type)) as string[]);
    for (const { type, path } of await reviewSkillPaths()) {
      if (expected.has(type)) continue;
      const source = await readFile(path, 'utf8').catch(() => '');
      expect(source.includes(APPROVED), `${type}/review.md carries the guard but is not in the declared set`).toBe(false);
    }
  });

  it('leaves no legacy phrasing in ANY review skill', async () => {
    // Scoped to every review skill, not to a hand-picked seven — `delegate/review.md` kept
    // "Don't rephrase correct text for style." precisely because it was off the old list.
    for (const { type, path } of await reviewSkillPaths()) {
      const source = await readFile(path, 'utf8').catch(() => '');
      for (const legacy of LEGACY) {
        expect(source, `${type}/review.md still carries a legacy phrasing`).not.toContain(legacy);
      }
    }
  });
});
