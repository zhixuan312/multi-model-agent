import { runOrchestrator, type OrchestratorDeps } from '../../packages/core/src/research/orchestrator.js';
import type { QueryPlan } from '../../packages/core/src/research/query-plan.js';

const emptyPlan: QueryPlan = {
  braveQueries: [], arxivQueries: [], semanticScholarQueries: [],
  githubQueries: [],
};

const fakeDeps = (): OrchestratorDeps => ({
  enabledAdapters: ['arxiv', 'semantic_scholar', 'github_search'],
  brave: { search: async (q) => ({ results: [{ title: `B:${q}`, url: `https://b/${q}`, snippet: '' }], keyIndex: 0, attempts: [] }) },
  adapters: {
    arxiv:           async (q) => [{ adapterId: 'arxiv',           recordId: '1', title: `A:${q}`,  url: `https://a/${q}`,  snippet: '', raw: {} }],
    semanticScholar: async (q) => [{ adapterId: 'semantic_scholar', recordId: '2', title: `S:${q}`, url: `https://s/${q}`,  snippet: '', raw: {} }],
    github:          async (q, kind) => [{ adapterId: 'github_search', recordId: '3', title: `G:${q}`, url: `https://g/${q}/${kind}`, snippet: '', raw: {} }],
  },
  perAdapterTimeoutMs: 1000,
  totalDeadlineMs:     5000,
  concurrencyCap:      8,
});

describe('orchestrator', () => {
  it('returns empty pack on empty plan', async () => {
    const pack = await runOrchestrator(emptyPlan, fakeDeps());
    expect(pack.sources.length).toBe(0);
    expect(pack.failedAttempts.length).toBe(0);
  });

  it('fans out brave + arxiv + ss + github(repo+code)', async () => {
    const plan: QueryPlan = {
      braveQueries:           ['b1'],
      arxivQueries:           ['a1'],
      semanticScholarQueries: ['s1'],
      githubQueries:          [{ q: 'g1', kind: 'repo' }, { q: 'g2', kind: 'code' }],
    };
    const pack = await runOrchestrator(plan, fakeDeps());
    const groups = new Set(pack.sources.map(s => s.source));
    expect(groups.has('brave')).toBe(true);
    expect(groups.has('arxiv')).toBe(true);
    expect(groups.has('semantic_scholar')).toBe(true);
    expect(groups.has('github_repo')).toBe(true);
    expect(groups.has('github_code')).toBe(true);
  });

  it('records failedAttempts when an adapter rejects', async () => {
    const deps = fakeDeps();
    deps.adapters.arxiv = async () => { throw new Error('rate_limited'); };
    const pack = await runOrchestrator(
      { ...emptyPlan, arxivQueries: ['x'] }, deps);
    expect(pack.failedAttempts.length).toBe(1);
    expect(pack.failedAttempts[0]!.reason).toBe('rate_limited');
    expect(pack.sources.length).toBe(0);
  });

  it('skips disabled adapters without recording failure', async () => {
    const deps = fakeDeps();
    deps.enabledAdapters = ['arxiv'];
    const plan: QueryPlan = { ...emptyPlan, semanticScholarQueries: ['x'] };
    const pack = await runOrchestrator(plan, deps);
    expect(pack.sources.length).toBe(0);
    expect(pack.failedAttempts.length).toBe(1);
    expect(pack.failedAttempts[0]!.reason).toBe('no_api_key_configured');
  });
});
