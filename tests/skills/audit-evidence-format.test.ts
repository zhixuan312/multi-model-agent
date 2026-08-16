import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_DIR = join(import.meta.dirname, '../../packages/core/src/skills/audit');

describe('audit evidence section-prefix format', () => {
  describe('skill instructions require section-prefixed evidence', () => {
    for (const file of ['implement.md', 'implement-plan.md', 'implement-spec.md', 'implement-skill.md']) {
      it(`${file} instructs workers to prefix evidence with [## or ### Heading]`, () => {
        const content = readFileSync(join(SKILLS_DIR, file), 'utf8');
        expect(content).toMatch(/\[##[#]?[^\]]+\]/);
      });
    }

    it('review.md instructs reviewer to verify section prefixes', () => {
      const content = readFileSync(join(SKILLS_DIR, 'review.md'), 'utf8');
      expect(content).toMatch(/section.*prefix|heading.*bracket|\[###/i);
    });
  });
});
