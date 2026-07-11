import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const FORGE_COMPONENTS = [
  'Context',
  'Problem',
  'Goals & Requirements',
  'Alternatives',
  'Technical Design',
  'Testing Plan',
  'Risks & Mitigations',
  'User Stories & Tasks',
];

describe('mma-spec prompts: subset-aware Forge-compatible structure', () => {
  const implMd = readFileSync('packages/core/src/skills/spec/implement.md', 'utf8');
  const reviewMd = readFileSync('packages/core/src/skills/spec/review.md', 'utf8');

  it('implementer template still contains all 8 canonical component headings', () => {
    for (const label of FORGE_COMPONENTS) {
      expect(implMd, `missing ## ${label}`).toContain(`## ${label}`);
    }
  });

  it('implementer instructions say requested components default to all 8', () => {
    expect(implMd).toContain('requested components');
    expect(implMd).toContain('default all 8');
    expect(implMd).toContain('exactly equal to the resolved component set');
    expect(implMd).toContain('zero `<!-- brief:` markers remain');
  });

  it('refiner instructions scope work to requested components and gate cross-component checks', () => {
    expect(reviewMd).toContain('requested components');
    expect(reviewMd).toContain('Goals & Requirements');
    expect(reviewMd).toContain('User Stories & Tasks');
    expect(reviewMd).toContain('skipped if either is absent');
    expect(reviewMd).toContain('exactly equal to the resolved component set');
    expect(reviewMd).toContain('`sections` must list exactly the resolved component set');
  });
});
