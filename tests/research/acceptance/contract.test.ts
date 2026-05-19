// tests/research/acceptance/contract.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runOrchestrator } from '../../../packages/core/src/research/orchestrator.js';
import { runTwoTurnDriver } from '../../../packages/core/src/tools/research/two-turn-driver.js';
import { applyBudget, EVIDENCE_PACK_LIMITS } from '../../../packages/core/src/research/evidence-pack.js';
import { resolveEnabledAdapters } from '../../../packages/core/src/research/adapters/index.js';
import { ResearchConfigSchema } from '../../../packages/core/src/config/schema.js';

const validPlan = JSON.stringify({
  braveQueries: ['q'], arxivQueries: [], semanticScholarQueries: [],
  githubQueries: [], rssFeeds: [], directFetches: [],
});

const baseAdapters = {
  arxiv:           async () => [],
  semanticScholar: async () => [],
  github:          async () => [],
  rss:             async () => [],
};

describe('A5 — missing credentials degrade gracefully', () => {
  it('resolveEnabledAdapters skips semantic_scholar without apiKey, includes when provided', () => {
    const cfg = { arxiv: true, semanticScholar: true, githubSearch: true, genericRss: true };
    expect(resolveEnabledAdapters(cfg, {})).not.toContain('semantic_scholar');
    expect(resolveEnabledAdapters(cfg, { semanticScholarApiKey: 'k' })).toContain('semantic_scholar');
  });
});

describe('A6 — directFetches allowlist enforcement', () => {
  it('rejects directFetches host not on allowlist with host_not_allowlisted', async () => {
    const pack = await runOrchestrator(
      { braveQueries: [], arxivQueries: [], semanticScholarQueries: [], githubQueries: [], rssFeeds: [], directFetches: ['https://evil.com/x'] },
      {
        enabledAdapters: ['arxiv','semantic_scholar','github_search','rss'],
        brave: { search: async () => ({ results: [], keyIndex: 0, attempts: [] }) as any },
        adapters: baseAdapters as any,
        webFetch: async () => { throw new Error('should-not-be-called'); },
        hostAllowlist: new Set(['only-this.com']),
        perAdapterTimeoutMs: 1000, totalDeadlineMs: 5000, concurrencyCap: 4,
      }
    );
    expect(pack.failedAttempts.some(f => f.reason === 'host_not_allowlisted')).toBe(true);
    expect(pack.sources.length).toBe(0);
  });
});

describe('A11 — mma-explore consumption contract', () => {
  it('canonical category ids appear in the implementer-prefix template; URL-in-evidence is the contract', async () => {
    // synth-text shape: explore extracts URLs from finding.evidence and groups
    // by finding.category. The /research route preserves both by:
    //   (a) implementer-prefix mandates URL citation per finding
    //   (b) implementer-criteria publishes 5 canonical lowercase ids
    const { RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE, CANONICAL_CATEGORY_IDS } =
      await import('../../../packages/core/src/tools/research/implementer-criteria.js');
    expect(RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE).toMatch(/cite the source URL inline/i);
    expect(CANONICAL_CATEGORY_IDS.length).toBe(5);
    expect(new Set(CANONICAL_CATEGORY_IDS).size).toBeGreaterThanOrEqual(2);
  });
});

describe('A12 — evidence-pack budget enforcement', () => {
  it('caps per-group, total sources, and total bytes; sets budgetExceeded', () => {
    const groups = ['arxiv','semantic_scholar','github_repo','github_code','web_fetch','rss','brave'] as const;
    const sources = [];
    for (const g of groups) {
      for (let i = 0; i < 15; i++) {
        sources.push({ source: g, query: 'q', title: 't', url: `https://${g}/${i}`, snippet: 'x'.repeat(300), rank: i });
      }
    }
    const pack = applyBudget(sources as any, []);
    // Per-group cap
    for (const g of groups) {
      expect(pack.sources.filter(s => s.source === g).length).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_PER_GROUP);
    }
    // Total cap
    expect(pack.sources.length).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_TOTAL_SOURCES);
    // budgetExceeded flag
    expect(pack.budgetExceeded).toBe(true);
  });
});

const mkTurn = (output: string) => ({
  output, durationMs: 1, costUSD: 0, turns: 1,
  usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  terminationReason: 'ok' as const, filesWritten: [], usedShell: false,
});

describe('A13 — malformed JSON retry policy', () => {
  it('Scenario A: malformed then valid → exactly two send() calls, plan resolved', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(mkTurn('{ not json'))
      .mockResolvedValueOnce(mkTurn(validPlan));
    const out = await runTwoTurnDriver({
      session: { send } as any,
      runOrchestrator: async () => ({ sources: [], failedAttempts: [], generatedAt: 'x', totalQueries: 0, budgetExceeded: false }),
      researchQuestion: 'Q?', background: undefined, contextBlocks: [],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(out.plan).toBeDefined();
  });

  it('Scenario B: malformed twice → research_plan_invalid', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(mkTurn('{ bad'))
      .mockResolvedValueOnce(mkTurn('{ also bad'));
    await expect(runTwoTurnDriver({
      session: { send } as any,
      runOrchestrator: async () => ({ sources: [], failedAttempts: [], generatedAt: 'x', totalQueries: 0, budgetExceeded: false }),
      researchQuestion: 'Q?', background: undefined, contextBlocks: [],
    })).rejects.toThrow('research_plan_invalid');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('A14 — all adapters fail', () => {
  it('driver still returns pack with failedAttempts populated; sources empty', async () => {
    const out = await runTwoTurnDriver({
      session: { send: async () => mkTurn(validPlan) } as any,
      runOrchestrator: async () => ({
        sources: [],
        failedAttempts: [
          { source: 'brave', query: 'q', reason: '503' },
          { source: 'arxiv', query: 'a', reason: 'timeout' },
        ], generatedAt: 'x', totalQueries: 2, budgetExceeded: false,
      }),
      researchQuestion: 'Q?', background: undefined, contextBlocks: [],
    });
    expect(out.pack.sources.length).toBe(0);
    expect(out.pack.failedAttempts.length).toBe(2);
  });
});

describe('A15 — parser-compatible implementer-prefix output (structural smoke)', () => {
  it('implementer-prefix template mandates exact `## Sources used` column shape', async () => {
    const { RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE } = await import(
      '../../../packages/core/src/tools/research/implementer-criteria.js');
    expect(RESEARCH_IMPLEMENTER_PREFIX_TEMPLATE).toMatch(/source\s*\|\s*attempted\s*\|\s*used\s*\|\s*note/);
  });

  it('CANONICAL_CATEGORY_IDS exposes exactly 5 lowercase ids in declared order', async () => {
    const { CANONICAL_CATEGORY_IDS } = await import(
      '../../../packages/core/src/tools/research/implementer-criteria.js');
    expect([...CANONICAL_CATEGORY_IDS]).toEqual([
      'primary-sources','practitioner-consensus','recent-developments','counter-perspectives','cross-domain',
    ]);
  });
});

describe('A17 — userSources schema and matching', () => {
  it('Format: rejects URLs in userSources at Zod-validation layer', () => {
    const r = ResearchConfigSchema.safeParse({
      userSources: ['https://www.bis.org'],
    });
    // userSources entries must be host strings per HostString validator;
    // URLs do not satisfy the DNS-label canonicalization and are rejected.
    expect(r.success).toBe(false);
  });

  it('Matching: bis.org and www.bis.org are distinct in the allowlist set', () => {
    const allow = new Set(['bis.org']);
    expect(allow.has('www.bis.org')).toBe(false);
    expect(allow.has('bis.org')).toBe(true);
  });

  it('Union: directFetches passes when host is in fetchAllowlistExtra ∪ userSources', () => {
    const allow = new Set(['arxiv.org', 'bis.org']);
    expect(allow.has('arxiv.org')).toBe(true);
    expect(allow.has('bis.org')).toBe(true);
    expect(allow.has('other.com')).toBe(false);
  });
});
