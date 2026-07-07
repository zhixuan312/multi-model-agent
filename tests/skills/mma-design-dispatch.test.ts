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

describe('mma-design SKILL.md: dispatch method and component alignment', () => {
  const skillMd = readFileSync('packages/server/src/skills/mma-design/SKILL.md', 'utf8');

  it('instructs HTTP POST /task for investigate, not Agent dispatch', () => {
    expect(skillMd).toContain('POST /task');
    expect(skillMd).toContain('"type": "investigate"');
    expect(skillMd).toContain('"type": "research"');
    expect(skillMd).toContain('"type": "journal_recall"');
  });

  it('explicitly warns against inline Agent dispatches', () => {
    expect(skillMd).toContain('never as inline Agent dispatches');
    expect(skillMd).toContain('Never use inline Agent dispatches');
  });

  it('interview sections list all 8 Forge-compatible components', () => {
    for (const label of FORGE_COMPONENTS) {
      expect(skillMd, `missing component: ${label}`).toContain(`**${label}**`);
    }
  });

  it('Phase 3 dispatch references the 8-component headings', () => {
    expect(skillMd).toContain('8-component');
    expect(skillMd).toContain('`##` headings');
  });
});
