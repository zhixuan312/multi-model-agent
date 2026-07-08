import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests that 5 skill markdown files contain an "Outcome semantics" section
 * with the compact success/failure and empty-findings guidance.
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

      it('documents success check via error === null', () => {
        const outcomeIndex = content.indexOf('## Outcome semantics');
        const contentFromOutcome = outcomeIndex >= 0 ? content.substring(outcomeIndex) : '';
        expect(contentFromOutcome).toMatch(/error.*null/i);
      });

      it('explicitly states that empty findings is not a failure', () => {
        const outcomeIndex = content.indexOf('## Outcome semantics');
        const contentFromOutcome = outcomeIndex >= 0 ? content.substring(outcomeIndex) : '';
        expect(contentFromOutcome).toMatch(/[Ee]mpty findings/);
      });
    });
  });
});
