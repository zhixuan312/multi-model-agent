import { describe, expect, it } from 'vitest';
import { researchBriefSlot } from '../../../packages/core/src/tools/research/brief-slot.js';
import {
  compileTurn1PlanPrompt,
  compileResearchImplementerPrefix,
  TOTAL_PREFIX_BUDGET_BYTES,
} from '../../../packages/core/src/tools/research/brief-slot.js';
import type { EvidencePack } from '../../../packages/core/src/research/evidence-pack.js';

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

const pack: EvidencePack = {
  sources: [{ source: 'arxiv', query: 'q', title: 'P', url: 'https://arxiv.org/abs/1', snippet: 's', rank: 0 }],
  failedAttempts: [{ source: 'semantic_scholar', query: 'q', reason: 'no_api_key_configured' }],
  generatedAt: '2026-05-19T00:00:00Z', totalQueries: 1, budgetExceeded: false,
};

describe('research brief-slot — turn-1 plan + implementer prefix', () => {
  it('compileTurn1PlanPrompt substitutes question + background placeholders', () => {
    const out = compileTurn1PlanPrompt({
      researchQuestion: 'How do stablecoins work?',
      background: 'background blob',
    });
    expect(out).toContain('How do stablecoins work?');
    expect(out).toContain('background blob');
    expect(out).not.toContain('<RESEARCH_QUESTION_PLACEHOLDER>');
    expect(out).not.toContain('<BACKGROUND_PLACEHOLDER>');
  });

  it('compileResearchImplementerPrefix embeds the serialized evidence pack and question', () => {
    const out = compileResearchImplementerPrefix({
      researchQuestion: 'Q?', background: 'B', pack, contextBlocks: [],
    });
    expect(out).toContain('Q?');
    expect(out).toMatch(/## Sources/);
    expect(out).toContain('no_api_key_configured');
  });

  it('enforces total prefix budget by trimming snippets then context then background', () => {
    const fatPack: EvidencePack = {
      ...pack,
      sources: Array.from({ length: 30 }, (_, i) => ({
        source: 'brave' as const, query: 'q', title: 't', url: `https://b/${i}`,
        snippet: 'x'.repeat(2000), rank: i,
      })),
    };
    const out = compileResearchImplementerPrefix({
      researchQuestion: 'Q?',
      background: 'y'.repeat(20000),
      pack: fatPack,
      contextBlocks: [],
    });
    expect(out.length).toBeLessThanOrEqual(TOTAL_PREFIX_BUDGET_BYTES);
  });

  it('TOTAL_PREFIX_BUDGET_BYTES is 96 KiB', () => {
    expect(TOTAL_PREFIX_BUDGET_BYTES).toBe(96 * 1024);
  });
});
