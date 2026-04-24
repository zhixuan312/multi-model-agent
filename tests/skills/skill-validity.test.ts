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

    it(`${dir}/SKILL.md is within line budget (≤80 lines)`, () => {
      const content = readFileSync(join(skillRoot, dir, 'SKILL.md'), 'utf8');
      expect(content.split('\n').length).toBeLessThanOrEqual(80);
    });
  }
});
