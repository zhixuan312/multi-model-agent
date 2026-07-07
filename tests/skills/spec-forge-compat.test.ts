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

describe('mma-spec template: Forge-compatible 8-component structure', () => {
  const implMd = readFileSync('packages/core/src/skills/spec/implement.md', 'utf8');

  it('template contains all 8 ## component headings', () => {
    for (const label of FORGE_COMPONENTS) {
      expect(implMd, `missing ## ${label}`).toContain(`## ${label}`);
    }
  });

  it('template uses ## (not ###) for all 8 component-level headings', () => {
    const templateBlock = implMd.match(/```markdown([\s\S]*?)```/)?.[1] ?? '';
    const lines = templateBlock.split('\n');
    for (const label of FORGE_COMPONENTS) {
      const h2Line = lines.find(l => l.trim() === `## ${label}`);
      expect(h2Line, `## ${label} not found in template`).toBeTruthy();
    }
  });

  it('self-validation checklist mentions all 8 components', () => {
    for (const label of FORGE_COMPONENTS) {
      expect(implMd).toContain(label);
    }
    expect(implMd).toContain('8 `##` component headings');
  });

  it('output JSON lists all 8 sections', () => {
    const jsonMatch = implMd.match(/"sections":\s*\[([^\]]+)\]/);
    expect(jsonMatch).toBeTruthy();
    const sectionsStr = jsonMatch![1];
    for (const label of FORGE_COMPONENTS) {
      expect(sectionsStr).toContain(`"${label}"`);
    }
  });
});
