import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const raw = readFileSync('packages/server/src/skills/multi-model-agent/SKILL.md', 'utf8');

describe('multi-model-agent router skill', () => {
  it('mentions /mma-flow and /mma-breakout as Claude Code commands in the skill map table', () => {
    expect(raw).toContain('| `/mma-flow` |');
    expect(raw).toContain('| `/mma-breakout` |');
    expect(raw).toContain('Command (Claude Code only)');
  });

  // `design through PR creation` used to be pinned here. It described one of the flow's three
  // dispositions as if it were the only one, so this assertion actively HELD the router wrong:
  // `commit-in-place` and `deliver-file` never cut a branch, open a PR, or merge, and an agent
  // reading only the router would decline to suggest `/mma-flow` for a report or outside git.
  // `router-decision-graph.test.ts` now pins all three dispositions and the graph's shape.
  it('teaches /mma-flow as the packaged end-to-end SDLC route, delivered by disposition', () => {
    expect(raw).toContain('full SDLC');
    expect(raw).toContain('design through delivery');
    expect(raw).toContain('`deliver-file`');
  });

  it('teaches /mma-breakout as the interactive breakout-room command', () => {
    expect(raw).toContain('/mma-breakout');
    expect(raw).toContain('interactive expert-persona breakout');
    expect(raw).toContain('direct `@name` conversation');
    expect(raw).toContain('one confirmed journal batch');
  });
});
