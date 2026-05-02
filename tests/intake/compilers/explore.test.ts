import { describe, expect, it } from 'vitest';
import { compileExplore } from '../../../packages/core/src/intake/compilers/explore.js';

const baseInput = {
  currentContext: 'a'.repeat(20),
  explorationQuestion: 'b'.repeat(20),
  anchors: [],
  contextBlockIds: [],
};

describe('compileExplore', () => {
  it('emits three TaskSpecs (internal, external, synthesizer)', () => {
    const r = compileExplore(baseInput, [], [], '/cwd', { userSources: [], hasBrave: true });
    expect(r.tasks.length).toBe(3);
    expect(r.tasks[0].route).toBe('explore_internal');
    expect(r.tasks[1].route).toBe('explore_external');
    expect(r.tasks[2].route).toBe('explore_synthesize');
  });

  it('internal task carries readonly tools and cwd-only sandbox', () => {
    const r = compileExplore(baseInput, [], [], '/cwd', { userSources: [], hasBrave: true });
    expect(r.tasks[0].tools).toBe('readonly');
    expect(r.tasks[0].sandboxPolicy).toBe('cwd-only');
  });

  it('external task includes userSources verbatim in its prompt', () => {
    const r = compileExplore(baseInput, [], [], '/cwd', {
      userSources: ['I check https://example.com', 'wiki at firm.local'],
      hasBrave: true,
    });
    expect(r.tasks[1].prompt).toContain('I check https://example.com');
    expect(r.tasks[1].prompt).toContain('wiki at firm.local');
  });

  it('external prompt mentions web_search only when Brave available', () => {
    const withBrave = compileExplore(baseInput, [], [], '/cwd', { userSources: [], hasBrave: true });
    expect(withBrave.tasks[1].prompt).toMatch(/web_search/);
    const noBrave = compileExplore(baseInput, [], [], '/cwd', { userSources: [], hasBrave: false });
    expect(noBrave.tasks[1].prompt).toMatch(/no open-web search is available/);
  });

  it('synthesizer prompt mentions sentinels and divergence axis distinctness', () => {
    const r = compileExplore(baseInput, [], [], '/cwd', { userSources: [], hasBrave: true });
    expect(r.tasks[2].prompt).toContain('(no internal anchor — fully greenfield)');
    expect(r.tasks[2].prompt).toContain('(no external source found)');
    expect(r.tasks[2].prompt).toMatch(/different `divergence axis`/);
  });

  it('synthesizer prompt is augmented with degraded flag when degradedSources provided', () => {
    const r = compileExplore(baseInput, [], [], '/cwd', {
      userSources: [], hasBrave: true,
      synthesizerDegradedSources: ['internal'],
    });
    expect(r.tasks[2].prompt).toMatch(/degraded.*internal/i);
  });
});
