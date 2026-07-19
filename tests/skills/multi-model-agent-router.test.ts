import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const raw = readFileSync('packages/server/src/skills/multi-model-agent/SKILL.md', 'utf8');

describe('multi-model-agent router skill', () => {
  it('mentions /mma-flow and /mma-breakout as Claude Code commands in the skill map table', () => {
    expect(raw).toContain('| `/mma-flow` |');
    expect(raw).toContain('| `/mma-breakout` |');
    expect(raw).toContain('Command (Claude Code only)');
  });

  it('teaches /mma-flow as the packaged end-to-end SDLC route', () => {
    expect(raw).toContain('/mma-flow');
    expect(raw).toContain('full SDLC');
    expect(raw).toContain('design through PR creation');
  });

  it('teaches /mma-breakout as the interactive breakout-room command', () => {
    expect(raw).toContain('/mma-breakout');
    expect(raw).toContain('interactive expert-persona breakout');
    expect(raw).toContain('direct `@name` conversation');
    expect(raw).toContain('one confirmed journal batch');
  });
});
