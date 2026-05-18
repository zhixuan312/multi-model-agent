import { describe, expect, it } from 'vitest';
import { researchBriefSlot } from '../../../packages/core/src/tools/research/brief-slot.js';

// All assertions go through the public slot (compileResearch is now a
// private function inside brief-slot.ts). Each test runs the slot on an
// enriched input and reads the resulting brief's compiledPrompt field —
// the assembled worker prompt.

const baseInput = {
  researchQuestion: 'What approaches exist for streaming JSON parsing under 100KB?',
  background: 'We currently use a single-pass push parser and want alternatives.',
  contextBlockIds: [],
  resolvedContextBlocks: [] as { id: string; content: string }[],
  userSources: [] as readonly string[],
  hasBrave: false,
};

function run(overrides: Partial<typeof baseInput> = {}) {
  const briefs = researchBriefSlot({ ...baseInput, ...overrides } as any);
  return briefs[0].compiledPrompt;
}

describe('researchBriefSlot — compiled prompt content', () => {
  it('embeds researchQuestion and background in the prompt', () => {
    const out = run();
    expect(out).toContain('streaming JSON');
    expect(out).toContain('single-pass push parser');
  });

  it('lists user-described sources verbatim', () => {
    const out = run({
      userSources: ['arxiv:cs.PL', 'github:topic:json-parser'],
      hasBrave: true,
    });
    expect(out).toContain('arxiv:cs.PL');
    expect(out).toContain('github:topic:json-parser');
  });

  it('includes Brave-search guidance only when hasBrave', () => {
    const withBrave = run({ hasBrave: true });
    expect(withBrave).toMatch(/web_search/);

    const withoutBrave = run({ hasBrave: false });
    expect(withoutBrave).toMatch(/no Brave keys configured|no open-web search/);
  });

  it('includes the trust-boundary preamble', () => {
    const out = run();
    expect(out).toMatch(/untrusted external data/i);
    expect(out).toMatch(/injection/i);
  });

  it('embeds context blocks at the top of the prompt', () => {
    const out = run({
      resolvedContextBlocks: [{ id: 'blk_1', content: 'PRIOR ROUND FINDINGS: …' }],
    });
    expect(out.indexOf('PRIOR ROUND FINDINGS')).toBeLessThan(
      out.indexOf('streaming JSON'),
    );
  });
});

describe('researchBriefSlot — brief construction', () => {
  it('returns one brief', () => {
    const briefs = researchBriefSlot({ ...baseInput } as any);
    expect(briefs).toHaveLength(1);
  });

  it('forwards contextBlockIds onto the brief', () => {
    const briefs = researchBriefSlot({ ...baseInput, contextBlockIds: ['cb-1'] } as any);
    expect(briefs[0].contextBlockIds).toEqual(['cb-1']);
  });
});
