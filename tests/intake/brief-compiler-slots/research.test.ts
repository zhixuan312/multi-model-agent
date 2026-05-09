import { describe, expect, it } from 'vitest';
import { compileResearch } from '../../../packages/core/src/intake/brief-compiler-slots/research.js';

const baseInput = {
  researchQuestion: 'What approaches exist for streaming JSON parsing under 100KB?',
  background: 'We currently use a single-pass push parser and want alternatives.',
  contextBlockIds: [],
};

describe('compileResearch', () => {
  it('embeds researchQuestion and background in the prompt', () => {
    const result = compileResearch(baseInput, [], '/cwd', { userSources: [], hasBrave: false });
    expect(result.task.prompt).toContain('streaming JSON');
    expect(result.task.prompt).toContain('single-pass push parser');
  });

  it('lists user-described sources verbatim', () => {
    const result = compileResearch(baseInput, [], '/cwd', {
      userSources: ['arxiv:cs.PL', 'github:topic:json-parser'],
      hasBrave: true,
    });
    expect(result.task.prompt).toContain('arxiv:cs.PL');
    expect(result.task.prompt).toContain('github:topic:json-parser');
  });

  it('includes Brave-search guidance only when hasBrave', () => {
    const withBrave = compileResearch(baseInput, [], '/cwd', { userSources: [], hasBrave: true });
    expect(withBrave.task.prompt).toMatch(/web_search/);

    const withoutBrave = compileResearch(baseInput, [], '/cwd', { userSources: [], hasBrave: false });
    expect(withoutBrave.task.prompt).toMatch(/no Brave keys configured|no open-web search/);
  });

  it('includes the trust-boundary preamble', () => {
    const result = compileResearch(baseInput, [], '/cwd', { userSources: [], hasBrave: false });
    expect(result.task.prompt).toMatch(/untrusted external data/i);
    expect(result.task.prompt).toMatch(/injection/i);
  });

  it('embeds context blocks at the top of the prompt', () => {
    const result = compileResearch(baseInput, [
      { id: 'blk_1', content: 'PRIOR ROUND FINDINGS: …' },
    ], '/cwd', { userSources: [], hasBrave: false });
    expect(result.task.prompt.indexOf('PRIOR ROUND FINDINGS')).toBeLessThan(
      result.task.prompt.indexOf('streaming JSON'),
    );
  });

  it('emits a single TaskSpec with route="research", tools="readonly", reviewPolicy="none"', () => {
    const result = compileResearch(baseInput, [], '/cwd', { userSources: [], hasBrave: false });
    expect(result.task.route).toBe('research');
    expect(result.task.tools).toBe('readonly');
    expect(result.task.reviewPolicy).toBe('none');
    expect(result.task.cwd).toBe('/cwd');
    expect(result.task.agentType).toBe('complex');
  });
});
