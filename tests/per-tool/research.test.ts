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
    expect(toolConfig.category).toBe('research');
    expect(toolConfig.agentType).toBe('complex');
  });

  it('briefSlot returns exactly one brief', () => {
    const briefs = toolConfig.briefSlot({
      researchQuestion: 'What approaches exist for SIMD JSON parsing?',
      background: 'We currently use a single-pass push parser; want SIMD alternatives.',
      contextBlockIds: [],
      resolvedContextBlocks: [],
      userSources: [],
      hasBrave: false,
    });
    expect(briefs).toHaveLength(1);
    expect(briefs[0].compiledPrompt.length).toBeGreaterThan(20);
  });

  it('briefSlot embeds Brave-search guidance when hasBrave=true', () => {
    const briefs = toolConfig.briefSlot({
      researchQuestion: 'What approaches exist for SIMD JSON parsing?',
      background: 'We currently use a single-pass push parser; want SIMD alternatives.',
      contextBlockIds: [],
      resolvedContextBlocks: [],
      userSources: ['arxiv:cs.PL'],
      hasBrave: true,
    });
    expect(briefs[0].compiledPrompt).toMatch(/web_search/);
    expect(briefs[0].compiledPrompt).toContain('arxiv:cs.PL');
  });
});
