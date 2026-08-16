import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SPEC_COMPONENT_CATALOG } from '@zhixuan92/multi-model-agent-core';

describe('mma-spec SKILL.md: subset components contract', () => {
  const skillMd = readFileSync('packages/server/src/skills/mma-spec/SKILL.md', 'utf8');

  it('documents the optional components request field', () => {
    expect(skillMd).toContain('| `components` | string[] | no |');
  });

  /**
   * Against the catalog, and against the LINE that declares them — not `toContain` over the whole
   * file. Eight `expect(skillMd).toContain('<label>')` calls stood here under the name "the exact
   * allowed canonical labels": `Context`, `Problem` and `Alternatives` occur throughout ordinary
   * prose in this document, so those three passed no matter what the allowed set said, and the
   * set itself was a ninth copy of a list `SPEC_COMPONENT_CATALOG` already owns.
   */
  it('declares exactly the catalog identifiers as the allowed labels', () => {
    const line = skillMd.split('\n').find((l) => l.includes('Allowed labels:'));
    expect(line, 'no "Allowed labels:" line in the components row').toBeDefined();

    const declared = [...line!.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1]!)
      .filter((label) => label !== 'components');
    expect(declared).toEqual(SPEC_COMPONENT_CATALOG.map((entry) => entry.id));
  });

  it('states that omitted or empty components means all eight components', () => {
    expect(skillMd).toContain('omitted or empty `components` means all eight components');
  });

  it('no longer references obsolete section vocabulary', () => {
    expect(skillMd).not.toContain('Decision Records');
    expect(skillMd).not.toContain('## Acceptance Criteria');
  });
});
