import { runTwoTurnDriver, type TwoTurnDeps } from '../../../packages/core/src/tools/research/two-turn-driver.js';

const fakeSession = (responses: string[]) => {
  let i = 0;
  return {
    send: async () => ({
      output:          responses[i++] ?? '',           // TurnResult.output (NOT .text)
      durationMs:      1,
      costUSD:         0,
      turns:           1,
      usage:           { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
      terminationReason: 'ok' as const,                 // 'ok' | 'error' | ... (NOT 'normal')
      filesWritten:    [],
      usedShell:       false,
    }),
  } as unknown as TwoTurnDeps['session'];
};

const baseDeps = (responses: string[]): TwoTurnDeps => ({
  session: fakeSession(responses),
  runOrchestrator: async () => ({
    sources: [{ source: 'arxiv', query: 'q', title: 'T', url: 'https://arxiv/1', snippet: 's', rank: 0 }],
    failedAttempts: [], generatedAt: '2026-05-19T00:00:00Z',
    totalQueries: 1, budgetExceeded: false,
  }),
  researchQuestion: 'Q?',
  background: undefined,
});

describe('two-turn-driver', () => {
  const validJson = JSON.stringify({
    braveQueries: ['q'], arxivQueries: [], semanticScholarQueries: [],
    githubQueries: [],
  });

  it('happy path — valid JSON turn-1 returns plan + orchestrator pack', async () => {
    const out = await runTwoTurnDriver(baseDeps([validJson]));
    expect(out.plan.braveQueries).toEqual(['q']);
    expect(out.pack.sources.length).toBe(1);
  });

  it('retries once on malformed turn-1 JSON, then succeeds on second attempt (A13 Scenario A)', async () => {
    const deps = baseDeps(['{ not json', validJson]);
    const out = await runTwoTurnDriver(deps);
    expect(out.plan.braveQueries).toEqual(['q']);
  });

  it('throws research_plan_invalid after second malformed JSON (A13 Scenario B)', async () => {
    const deps = baseDeps(['{ also not json', 'still {bad json}']);
    await expect(runTwoTurnDriver(deps)).rejects.toThrow('research_plan_invalid');
  });

  it('all-adapters-fail path — empty sources, failedAttempts populated (A14)', async () => {
    const deps = baseDeps([validJson]);
    deps.runOrchestrator = async () => ({
      sources: [], failedAttempts: [
        { source: 'brave', query: 'q', reason: '503' },
        { source: 'arxiv', query: 'q', reason: 'timeout' },
      ], generatedAt: 'x', totalQueries: 2, budgetExceeded: false,
    });
    const out = await runTwoTurnDriver(deps);
    expect(out.pack.sources.length).toBe(0);
    expect(out.pack.failedAttempts.length).toBe(2);
  });
});
