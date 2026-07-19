import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const rootReadme = readFileSync('README.md', 'utf8');
const serverReadme = readFileSync('packages/server/README.md', 'utf8');

describe('mma-breakout command documentation', () => {
  it('lists /mma-breakout in the root README command table', () => {
    expect(rootReadme).toContain('### Commands (Claude Code only)');
    expect(rootReadme).toContain('| `/mma-breakout` |');
    expect(rootReadme).toContain('interactive expert-persona breakout');
  });

  it('lists /mma-breakout in the server README command table', () => {
    expect(serverReadme).toContain('### Commands (Claude Code only)');
    expect(serverReadme).toContain('| `/mma-breakout` |');
    expect(serverReadme).toContain('named breakout teammate');
  });
});
