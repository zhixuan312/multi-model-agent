import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractEvidenceSections } from '../../packages/core/src/reporting/extract-evidence-sections.js';

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

  describe('extractEvidenceSections utility', () => {
    it('extracts a single section heading', () => {
      const result = extractEvidenceSections('[### Task 3: Wire up handler] "See the spec for matching rules"');
      expect(result.sections).toEqual(['### Task 3: Wire up handler']);
      expect(result.text).toBe('"See the spec for matching rules"');
    });

    it('extracts multiple section headings', () => {
      const result = extractEvidenceSections('[### Task 3] [### Task 5] "Both reference the same config"');
      expect(result.sections).toEqual(['### Task 3', '### Task 5']);
      expect(result.text).toBe('"Both reference the same config"');
    });

    it('handles evidence without section prefix (legacy format)', () => {
      const result = extractEvidenceSections('Section 2 lacks boundary definition');
      expect(result.sections).toEqual([]);
      expect(result.text).toBe('Section 2 lacks boundary definition');
    });

    it('handles ## component-level headings', () => {
      const result = extractEvidenceSections('[## Goals & Requirements] "No acceptance criteria defined"');
      expect(result.sections).toEqual(['## Goals & Requirements']);
      expect(result.text).toBe('"No acceptance criteria defined"');
    });

    it('handles # document-level headings (preamble)', () => {
      const result = extractEvidenceSections('[# Implementation Plan] "Goal contradicts Architecture"');
      expect(result.sections).toEqual(['# Implementation Plan']);
      expect(result.text).toBe('"Goal contradicts Architecture"');
    });

    it('trims whitespace from extracted text', () => {
      const result = extractEvidenceSections('[### Setup]   quoted text with spaces  ');
      expect(result.sections).toEqual(['### Setup']);
      expect(result.text).toBe('quoted text with spaces');
    });

    it('handles empty string', () => {
      const result = extractEvidenceSections('');
      expect(result.sections).toEqual([]);
      expect(result.text).toBe('');
    });
  });
});
