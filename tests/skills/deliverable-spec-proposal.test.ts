import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SPEC_COMPONENT_CATALOG, resolveComponentHeading } from '@zhixuan92/multi-model-agent-core';

describe('deliverable-neutral spec authoring', () => {
  it('dual-reads headings and requires a proposed contract', () => {
    expect(resolveComponentHeading('Technical Design')).toBe('Technical Design');
    expect(resolveComponentHeading('Approach, Method & Structure')).toBe('Technical Design');
    expect(SPEC_COMPONENT_CATALOG).toHaveLength(8);
    const prompt = readFileSync('packages/core/src/skills/spec/implement.md', 'utf8');
    for (const term of ['state: proposed', 'artifacts', 'acceptance', 'references', 'disposition', 'why']) expect(prompt.toLowerCase()).toContain(term);
  });
});