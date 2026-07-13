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
      // SDLC pipeline playbook. It carries the entire per-stage operational
      // handbook (what/who/how to call) plus the multi-repo fan-out model
      // (B4–B9 per repo, 1 repo = 1 execute_plan request), so it is
      // legitimately far longer than any worker skill and gets a much higher
      // budget. Bumped 380 → 450 when the multi-repo fan-out landed.
      const LINE_BUDGET = { 'mma-flow': 450 };
      const budget = LINE_BUDGET[dir] ?? 320;
      expect(content.split('\n').length).toBeLessThanOrEqual(budget);
    });

    it(`${dir}/SKILL.md has version: "0.0.0-unreleased" in source frontmatter`, () => {
      const content = readFileSync(join(skillRoot, dir, 'SKILL.md'), 'utf8');
      const { data } = matter(content);
      expect(data.version, `${dir}/SKILL.md must have version field`).toBe('0.0.0-unreleased');
    });
  }

  it('every dist SKILL.md has version matching server package.json', () => {
    const distRoot = 'packages/server/dist/skills';
    if (!existsSync(distRoot)) return; // build hasn't run in CI yet
    const pkgVersion = JSON.parse(readFileSync('packages/server/package.json', 'utf8')).version;
    const distDirs = readdirSync(distRoot).filter(d => !d.startsWith('_') && statSync(join(distRoot, d)).isDirectory());
    for (const dir of distDirs) {
      const content = readFileSync(join(distRoot, dir, 'SKILL.md'), 'utf8');
      const { data } = matter(content);
      expect(data.version, `dist/${dir}/SKILL.md version`).toBe(pkgVersion);
    }
  });
});
