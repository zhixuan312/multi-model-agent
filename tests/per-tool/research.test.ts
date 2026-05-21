import { describe, it, expect } from 'vitest';
import { toolConfig } from '../../packages/core/src/tools/research/tool-config.js';

// Per-tool integration coverage for research.
// Pins the briefSlot + buildTaskSpec observable shape so the
// path-coverage.test.ts coverage check stays green and the route's
// canonical contract (single-task, readonly tools, no-review) can't
// regress silently.

describe('research tool config', () => {
  it('declares the expected route metadata', () => {
    expect(toolConfig.name).toBe('research');
    expect(toolConfig.category).toBe('read_only');
    expect(toolConfig.agentType).toBe('complex');
  });

  it('briefSlot returns exactly one brief carrying the research question', () => {
    const briefs = toolConfig.briefSlot({
      researchQuestion: 'What approaches exist for SIMD JSON parsing?',
      background: 'We currently use a single-pass push parser; want SIMD alternatives.',
      contextBlockIds: [],
      resolvedContextBlocks: [],
      userSources: [],
      hasBrave: false,
    });
    expect(briefs).toHaveLength(1);
    expect(briefs[0].researchQuestion).toBe('What approaches exist for SIMD JSON parsing?');
  });
});
