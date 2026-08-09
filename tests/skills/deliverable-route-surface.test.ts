import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8').toLowerCase();

describe('deliverable-neutral route surface', () => {
  it('requires varied exploration directions and non-code subjects', () => {
    const explore = read('packages/server/src/skills/mma-explore/SKILL.md');
    expect(explore).toContain('resolution shape');
    expect(explore).toContain('at least two distinct');
    expect(read('packages/core/src/skills/investigate/implement.md')).toContain('spreadsheets');
    expect(read('packages/core/src/skills/debug/implement.md')).toContain('deliverable');
  });
});