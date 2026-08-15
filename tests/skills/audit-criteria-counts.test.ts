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


/**
 * The same defect class, one skill over.
 *
 * `spec/review.md` opens its Process with "Apply each of the 11 criteria below sequentially" and
 * then numbers them 1..11. Both live in one file, so this is cheaper to catch than audit's
 * cross-file version — but nothing caught it, and the failure mode is identical: add a twelfth
 * check and the refiner is told to apply eleven, so the new one is skipped on every spec review,
 * silently, by the instruction that sits above it.
 */
describe('the spec refiner applies as many criteria as it lists', () => {
  const REVIEW = 'packages/core/src/skills/spec/review.md';

  it('the stated count matches the numbered checks', () => {
    const text = readFileSync(REVIEW, 'utf8');
    const claimed = /Apply each of the (\d+) criteria/.exec(text);
    expect(claimed, 'review.md no longer states how many criteria it applies').not.toBeNull();

    // Scoped to the Checks section: the Process list above it also numbers a bold step
    // ("3. **Complete any unfinished scaffold.**"), and counting that one made this assertion
    // read 12 against a correct claim of 11.
    const section = /^## Checks$([\s\S]*?)^## /m.exec(text);
    expect(section, 'review.md has no ## Checks section to count').not.toBeNull();
    const checks = [...section![1].matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(checks.length, `review.md numbers ${checks.length} checks but claims ${claimed![1]}`)
      .toBe(Number(claimed![1]));
    // Numbered consecutively from 1 — a duplicated or skipped number would make the count agree
    // by accident while the reviewer works through a list that is missing an entry.
    expect(checks).toEqual(checks.map((_, i) => i + 1));
  });
});

/**
 * Nothing on the audit path may instruct a write, including the Stop-hook GOAL.
 *
 * `audit` is registered `read-only`, so `claude-cwd-confinement` denies every write tool. The audit
 * prompts were corrected to say "working memory" — but `goal-conditions.ts` still told the worker
 * "you wrote findings to the scratch file… you have read the scratch file", and that text is
 * enforced by the Stop hook, which RE-BLOCKS the worker until the goal holds. A worker was held
 * against a condition the sandbox forbids, one layer above the prompts that had been fixed. A third
 * instance survived in `implement-plan.md`'s perspective-10 fallback.
 */
describe('the audit goal condition respects the read-only sandbox', () => {
  it('the goal never names a scratch file', () => {
    const goals = readFileSync('packages/server/src/application/goal-conditions.ts', 'utf8');
    const auditGoal = /case 'audit': \{([\s\S]*?)\n    \}/.exec(goals);
    expect(auditGoal, 'the audit goal moved — this test can no longer read it').not.toBeNull();
    // Strip comments: the fix documents the old wording, which is worth keeping.
    const body = auditGoal![1].replace(/\/\/[^\n]*/g, '');
    expect(body, 'the Stop-hook goal instructs a write the sandbox denies')
      .not.toMatch(/scratch file/i);
  });

  it.each(Object.values(VARIANTS))('%s never instructs a scratch-file write', (file) => {
    const text = readFileSync(join(AUDIT_DIR, file), 'utf8');
    // "there is no scratch file" is the correction and must stay; an instruction TO one must not.
    expect(text).not.toMatch(/(?:write|writing)[^.\n]{0,40}to the scratch file/i);
  });

  it('audit is still read-only, which is what makes this required', () => {
    const registry = readFileSync('packages/core/src/unified/type-registry.ts', 'utf8');
    expect(registry).toMatch(/audit:\s*\{[^}]*sandbox:\s*'read-only'/);
  });
});
