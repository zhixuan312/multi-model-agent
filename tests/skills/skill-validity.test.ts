import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

const skillRoot = 'packages/server/src/skills';
const skillDirs = readdirSync(skillRoot).filter(d => !d.startsWith('_') && statSync(join(skillRoot, d)).isDirectory());

describe('skill validity', () => {
  for (const dir of skillDirs) {
    it(`${dir}/SKILL.md has valid frontmatter`, () => {
      const content = readFileSync(join(skillRoot, dir, 'SKILL.md'), 'utf8');
      const { data } = matter(content);
      expect(data.name).toBeDefined();
      expect(data.description).toBeDefined();
      expect(data.when_to_use).toBeDefined();
    });

    it(`${dir}/SKILL.md: all @include _shared/*.md resolve`, () => {
      const content = readFileSync(join(skillRoot, dir, 'SKILL.md'), 'utf8');
      const includes = [...content.matchAll(/@include (_shared\/[^\s]+\.md)/g)];
      for (const m of includes) {
        const p = join(skillRoot, m[1]);
        expect(existsSync(p), `missing include ${p}`).toBe(true);
      }
    });

    it(`${dir}/SKILL.md is within line budget`, () => {
      const content = readFileSync(join(skillRoot, dir, 'SKILL.md'), 'utf8');
      // Budget bumped 220 → 320 in v5 to accommodate the v5 wire-shape
      // documentation rewrite per Tasks 24a/b/c.
      // Per-skill overrides: mma-flow is NOT a worker skill — it is the full
      // solution-delivery pipeline playbook. It carries the entire per-stage
      // operational handbook (what/who/how to call) plus the multi-repo
      // fan-out model (B4–B9 per repo, 1 repo = 1 execute_plan request), so
      // it is legitimately far longer than any worker skill and gets a much
      // higher budget. Bumped 380 → 450 when the multi-repo fan-out landed.
      // Bumped 450 → 700 when the LOCATE matrix went disposition-driven
      // (pr / commit-in-place / deliver-file): the release deliberately
      // reproduces the full resume matrix, the approval gate, acceptance
      // closure, and bounded non-progress in the doc rather than summarising
      // them, because a summary is not something an implementer can build
      // from or an auditor can check (see the spec's LOCATE matrix section).
      // Bumped 700 → 780 to close two acceptance criteria whose caller-side half
      // was missing while their engine-side half shipped, which is precisely the
      // gap a line budget must not be allowed to enforce:
      //   - AC-6.2 (second clause, since retired — SPEC-005 Task I-6): a flow's
      //     persisted technique-routing field used to drive EVERY dispatch.
      //     Without it, the retired legacy code-technique assets shipped
      //     unreachable — no caller surface named the field — so the technique
      //     was preserved in the file and lost in the flow.
      //   - AC-3.7 (execution half): the declared bounds every acceptance command
      //     runs under, and the `failed` vs `error` + `errorKind` distinction. The
      //     constants were exported and applied nowhere.
      // Both are operational contracts a caller executes, so they belong in the
      // stage that runs them, not in a summary elsewhere.
      const LINE_BUDGET: Record<string, number> = { 'mma-flow': 780 };
      const budget = LINE_BUDGET[dir] ?? 320;
      expect(content.split('\n').length).toBeLessThanOrEqual(budget);
    });

    it(`${dir}/SKILL.md has version: "0.0.0-unreleased" in source frontmatter`, () => {
      const content = readFileSync(join(skillRoot, dir, 'SKILL.md'), 'utf8');
      const { data } = matter(content);
      expect(data.version, `${dir}/SKILL.md must have version field`).toBe('0.0.0-unreleased');
    });
  }

  // `it.skipIf`, not an early `return`. The body used to open with
  // `if (!existsSync(distRoot)) return;`, which reports a PASS for a check that ran nothing —
  // indistinguishable in the output from one that verified every dist skill. This is the guard
  // against publishing skills stamped with the wrong version, so "did it actually run?" is the
  // whole question, and the runner should answer it.
  const distRoot = 'packages/server/dist/skills';
  it.skipIf(!existsSync(distRoot))('every dist SKILL.md has version matching server package.json', () => {
    const pkgVersion = JSON.parse(readFileSync('packages/server/package.json', 'utf8')).version;
    const distDirs = readdirSync(distRoot).filter(d => !d.startsWith('_') && statSync(join(distRoot, d)).isDirectory());
    for (const dir of distDirs) {
      const content = readFileSync(join(distRoot, dir, 'SKILL.md'), 'utf8');
      const { data } = matter(content);
      expect(data.version, `dist/${dir}/SKILL.md version`).toBe(pkgVersion);
    }
  });
});
