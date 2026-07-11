import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('mma-spec SKILL.md: subset components contract', () => {
  const skillMd = readFileSync('packages/server/src/skills/mma-spec/SKILL.md', 'utf8');

  it('documents the optional components request field', () => {
    expect(skillMd).toContain('| `components` | string[] | no |');
  });

  it('lists the exact allowed canonical labels', () => {
    expect(skillMd).toContain('Context');
    expect(skillMd).toContain('Problem');
    expect(skillMd).toContain('Goals & Requirements');
    expect(skillMd).toContain('Alternatives');
    expect(skillMd).toContain('Technical Design');
    expect(skillMd).toContain('Testing Plan');
    expect(skillMd).toContain('Risks & Mitigations');
    expect(skillMd).toContain('User Stories & Tasks');
  });

  it('states that omitted or empty components means all eight components', () => {
    expect(skillMd).toContain('omitted or empty `components` means all eight components');
  });

  it('no longer references obsolete section vocabulary', () => {
    expect(skillMd).not.toContain('Decision Records');
    expect(skillMd).not.toContain('## Acceptance Criteria');
  });
});
