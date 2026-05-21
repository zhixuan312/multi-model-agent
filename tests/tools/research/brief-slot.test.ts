import { describe, expect, it } from 'vitest';
import { researchBriefSlot } from '../../../packages/core/src/tools/research/brief-slot.js';
import {
  compileTurn1PlanPrompt,
  compileResearchImplementerPrefix,
  TOTAL_PREFIX_BUDGET_BYTES,
} from '../../../packages/core/src/tools/research/brief-slot.js';
import type { EvidencePack } from '../../../packages/core/src/research/evidence-pack.js';

// The legacy single-pass compiledPrompt was removed; the slot now carries
// only researchQuestion + contextBlockIds. The actual worker input is the
// two-turn pre-loop prefix (compileResearchImplementerPrefix), tested below.

const baseInput = {
  researchQuestion: 'What approaches exist for streaming JSON parsing under 100KB?',
  background: 'We currently use a single-pass push parser and want alternatives.',
  contextBlockIds: [],
  resolvedContextBlocks: [] as { id: string; content: string }[],
  userSources: [] as readonly string[],
  hasBrave: false,
};

describe('researchBriefSlot — brief construction', () => {
  it('returns one brief carrying the research question', () => {
    const briefs = researchBriefSlot({ ...baseInput } as any);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].researchQuestion).toBe(baseInput.researchQuestion);
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
      contextBlocks: [
        { id: 'ctx1', content: 'z'.repeat(15000) },
        { id: 'ctx2', content: 'w'.repeat(15000) },
      ],
    });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(TOTAL_PREFIX_BUDGET_BYTES);
  });

  it('TOTAL_PREFIX_BUDGET_BYTES is 96 KiB', () => {
    expect(TOTAL_PREFIX_BUDGET_BYTES).toBe(96 * 1024);
  });
});
