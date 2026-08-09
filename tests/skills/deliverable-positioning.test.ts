import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8').toLowerCase();

describe('deliverable-agnostic product positioning', () => {
  it('states the solution lifecycle and caller-owned workflow consistently', () => {
    for (const path of ['DIRECTION.md', 'GUIDELINES.md', 'README.md', 'docs/ARCHITECTURE.md']) {
      expect(read(path)).toContain('solution development lifecycle');
    }
    expect(read('DIRECTION.md')).toContain('caller owns the workflow');
    expect(read('DIRECTION.md')).not.toContain('mma-forge owns the sdlc chain');
    expect(read('GUIDELINES.md')).toContain('stateless requests, stateful caller');
  });
});