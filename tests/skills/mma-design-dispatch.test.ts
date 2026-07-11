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

  it('documents default-all-eight plus explicit-subset-only narrowing', () => {
    expect(skillMd).toContain('default to all eight components');
    expect(skillMd).toContain('explicit subset intent');
    expect(skillMd).toContain('ask exactly one clarifying question');
    expect(skillMd).toContain('never narrows on a borderline or inferred signal');
    expect(skillMd).toContain('"components"');
  });
});
