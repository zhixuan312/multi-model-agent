import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const required = [
  'D1 → phase_enter(discover)',
  'spec approval → phase_satisfy(refine)',
  'plan approval → phase_satisfy(design)',
  'B5 → focus_set(execute)',
  'B7 → phase_satisfy(verify)',
  'B10 → phase_satisfy(deliver) + focus_set(deliver)',
];

describe('Lifecycle flow guidance', () => {
  it('keeps the source and generated command aligned and explicitly advisory', () => {
    const source = readFileSync(resolve(root, 'packages/server/src/skills/mma-flow/SKILL.md'), 'utf8');
    const generated = readFileSync(resolve(root, 'plugin/commands/flow.md'), 'utf8');
    for (const mapping of required) {
      expect(source).toContain(mapping);
      expect(generated).toContain(mapping);
    }
    expect(source).toMatch(/caller action/i);
    expect(source).toMatch(/does not enforce/i);
    expect(generated).toMatch(/caller action/i);
    expect(generated).toMatch(/does not enforce/i);
  });
});