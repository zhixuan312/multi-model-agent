import { describe, it, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests that 5 skill markdown files contain an "Outcome semantics" section
 * with specific requirements for findings outcome documentation.
 */
describe('Skill files: Outcome semantics section', () => {
  const skillFiles = [
    'packages/server/src/skills/mma-investigate/SKILL.md',
    'packages/server/src/skills/mma-audit/SKILL.md',
    'packages/server/src/skills/mma-review/SKILL.md',
    'packages/server/src/skills/mma-debug/SKILL.md',
    'packages/server/src/skills/mma-research/SKILL.md',
  ];

  skillFiles.forEach((filePath) => {
    describe(`${filePath}`, () => {
      let content: string;

      beforeAll(() => {
        content = readFileSync(resolve(filePath), 'utf8');
      });

      it('contains "Outcome semantics" section (h2 heading)', () => {
        expect(content).toMatch(/^## Outcome semantics$/m);
      });

      it('contains all three enum values: found, clean, not_applicable', () => {
        const outcomeIndex = content.indexOf('## Outcome semantics');
        const contentFromOutcome = outcomeIndex >= 0 ? content.substring(outcomeIndex) : '';
        expect(contentFromOutcome).toMatch(/\bfound\b/);
        expect(contentFromOutcome).toMatch(/\bclean\b/);
        expect(contentFromOutcome).toMatch(/\bnot_applicable\b/);
      });

      it('contains explanation of findingsOutcomeReason presence rule', () => {
        const outcomeIndex = content.indexOf('## Outcome semantics');
        const contentFromOutcome = outcomeIndex >= 0 ? content.substring(outcomeIndex) : '';
        expect(contentFromOutcome).toMatch(/findingsOutcomeReason/);
      });

      it('explicitly states that empty findings ≠ failure', () => {
        const outcomeIndex = content.indexOf('## Outcome semantics');
        const contentFromOutcome = outcomeIndex >= 0 ? content.substring(outcomeIndex) : '';
        expect(contentFromOutcome).toMatch(/[Ee]mpty findings/);
      });

      it('contains per-route legal-outcome list', () => {
        const outcomeIndex = content.indexOf('## Outcome semantics');
        const contentFromOutcome = outcomeIndex >= 0 ? content.substring(outcomeIndex) : '';
        expect(contentFromOutcome).toMatch(/legal.*outcome/i);
      });
    });
  });
});
