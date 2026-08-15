/**
 * The audit reviewer's coverage check counts criteria. Those counts must match the implementers.
 *
 * `audit/review.md` step 4 reads: "Coverage — all criteria evaluated? Default=11, Plan=12, Spec=9,
 * Skill=7. Add 'no findings' for skipped criteria." Those four numbers are the reviewer's only
 * handle on whether the implementer skipped a criterion, and they are stated in a DIFFERENT file
 * from the criteria they count — one prompt asserting a fact about four others.
 *
 * Add a criterion to `implement-plan.md` and the reviewer keeps demanding twelve: the thirteenth
 * is never checked for coverage, silently, on every plan audit. Drop one and the reviewer demands
 * a criterion that no longer exists, so the implementer is told to add "no findings" for a slug it
 * was never asked to evaluate.
 *
 * Nothing pinned them. They happen to agree today; this keeps them agreeing, and derives the true
 * count from each implementer's own `criteriaCovered` example rather than restating it a sixth
 * time.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AUDIT_DIR = 'packages/core/src/skills/audit';

/** Subtype label as `review.md` writes it → the implementer file it describes. */
const VARIANTS: Record<string, string> = {
  Default: 'implement.md',
  Plan: 'implement-plan.md',
  Spec: 'implement-spec.md',
  Skill: 'implement-skill.md',
};

/** The criterion slugs an implementer's own output example enumerates. */
function criteriaSlugs(file: string): string[] {
  const text = readFileSync(join(AUDIT_DIR, file), 'utf8');
  const block = /"criteriaCovered":\s*\[(.*?)\]/s.exec(text);
  if (!block) throw new Error(`${file}: no criteriaCovered example to count`);
  return [...block[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!);
}

/** What `review.md`'s coverage step claims each subtype has. */
function reviewerClaims(): Record<string, number> {
  const text = readFileSync(join(AUDIT_DIR, 'review.md'), 'utf8');
  const claims: Record<string, number> = {};
  for (const [, label, count] of text.matchAll(/\b(Default|Plan|Spec|Skill)=(\d+)/g)) {
    claims[label!] = Number(count);
  }
  return claims;
}

describe('audit criteria counts agree across the skill pair', () => {
  const claims = reviewerClaims();

  it('the reviewer states a count for every subtype', () => {
    expect(Object.keys(claims).sort()).toEqual(Object.keys(VARIANTS).sort());
  });

  it.each(Object.entries(VARIANTS))('%s: the reviewer count matches %s', (label, file) => {
    const slugs = criteriaSlugs(file);
    expect(slugs.length, `${file} lists ${slugs.length} criteria; review.md claims ${claims[label]}`)
      .toBe(claims[label]);
  });

  it.each(Object.entries(VARIANTS))('%s: %s names each criterion once', (_label, file) => {
    const slugs = criteriaSlugs(file);
    expect(new Set(slugs).size, `duplicate criterion slug in ${file}`).toBe(slugs.length);
  });
});

/**
 * `audit` is a `read-only` route: `claude-cwd-confinement.ts` denies every write tool and every
 * mutating shell command, regardless of path. All four implementers used to open with "Try writing
 * to `/tmp/audit-findings.md`. If writes are blocked, proceed with in-memory notes" — an
 * instruction the engine's own sandbox guarantees will fail, on every audit run, spending a tool
 * call to be told no and teaching the model that a retry might work.
 */
describe('audit prompts do not instruct a write the sandbox forbids', () => {
  const VARIANT_FILES = Object.values(VARIANTS);

  it.each(VARIANT_FILES)('%s tells the worker to keep notes in memory, not on disk', (file) => {
    const text = readFileSync(join(AUDIT_DIR, file), 'utf8');
    expect(text, `${file} still names a scratch file path`).not.toMatch(/\/tmp\//);
    expect(text).toMatch(/working memory/i);
  });

  it('audit is still registered read-only, which is what makes that true', () => {
    const registry = readFileSync('packages/core/src/unified/type-registry.ts', 'utf8');
    expect(registry).toMatch(/audit:\s*\{[^}]*sandbox:\s*'read-only'/);
  });
});
