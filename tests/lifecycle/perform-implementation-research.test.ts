import { describe, it, expect, vi } from 'bun:test';
import { runResearchPreLoop } from '../../packages/core/src/research/research-pre-loop.js';

const validPlan = JSON.stringify({
  braveQueries: [], arxivQueries: [], semanticScholarQueries: [],
  githubQueries: [],
});

const mkTurn = (output: string) => ({
  output, durationMs: 1, costUSD: 0, turns: 1,
  usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  terminationReason: 'ok' as const, filesWritten: [], usedShell: false,
});

describe('runResearchPreLoop — builds EvidencePack and produces synthesis prefix', () => {
  it('runs plan turn once, then returns a prefix containing the EvidencePack', async () => {
    const send = vi.fn().mockResolvedValueOnce(mkTurn(validPlan));

    const result = await runResearchPreLoop({
      session: { send } as any,
      researchQuestion: 'Q?',
      background: undefined,
      resolvedContextBlocks: [],
      cfg: {
        brave:            { apiKeys: [], timeoutMs: 5000, maxResultsPerQuery: 5, perCallBackoffMs: 100 },
        fetch:            { maxRedirects: 3, connectTimeoutMs: 5000, totalDeadlineMs: 12000, maxBodyBytes: 1024 * 1024, allowPrivateNetwork: false },
        builtinAdapters:  { arxiv: true, semanticScholar: false, githubSearch: true, genericRss: true },
        fetchAllowlistExtra: [] as string[],
        userSources:      [] as string[],
      },
    });

    // 1 plan turn = 1 send (no synthesis here; perform-implementation hands
    // result.cachedPrefix to runReadRouteImplementer which adds 5 more sends).
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.cachedPrefix).toMatch(/## Sources/);
    expect(result.pack.sources).toBeDefined();
  });
});
