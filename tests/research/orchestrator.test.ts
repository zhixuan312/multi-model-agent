import { runOrchestrator, type OrchestratorDeps } from '../../packages/core/src/research/orchestrator.js';
import type { QueryPlan } from '../../packages/core/src/research/query-plan.js';

const emptyPlan: QueryPlan = {
  braveQueries: [], arxivQueries: [], semanticScholarQueries: [],
  githubQueries: [], openalexQueries: [], crossrefQueries: [], pubmedQueries: [],
};

const fakeDeps = (): OrchestratorDeps => ({
  enabledAdapters: ['arxiv', 'semantic_scholar', 'github_search', 'openalex', 'crossref', 'pubmed'],
  brave: { search: async (q, opts) => ({ results: [{ title: `B:${q}`, url: `https://b/${q}`, snippet: '', pageAge: opts?.freshness ? '2026-01-01' : undefined }], keyIndex: 0, attempts: [] }) },
  adapters: {
    arxiv:           async (q) => [{ adapterId: 'arxiv',            recordId: '1', title: `A:${q}`,  url: `https://a/${q}`,  snippet: '', raw: {} }],
    semanticScholar: async (q) => [{ adapterId: 'semantic_scholar', recordId: '2', title: `S:${q}`,  url: `https://s/${q}`,  snippet: '', raw: {} }],
    github:          async (q, kind) => [{ adapterId: 'github_search', recordId: '3', title: `G:${q}`, url: `https://g/${q}/${kind}`, snippet: '', raw: {} }],
    openalex:        async (q) => [{ adapterId: 'openalex',         recordId: '4', title: `OA:${q}`, url: `https://oa/${q}`, snippet: '', raw: {} }],
    crossref:        async (q) => [{ adapterId: 'crossref',         recordId: '5', title: `CR:${q}`, url: `https://cr/${q}`, snippet: '', raw: {} }],
    pubmed:          async (q) => [{ adapterId: 'pubmed',           recordId: '6', title: `PM:${q}`, url: `https://pm/${q}`, snippet: '', raw: {} }],
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

  it('fans out all 8 source groups', async () => {
    const plan: QueryPlan = {
      braveQueries:           [{ q: 'b1' }],
      arxivQueries:           ['a1'],
      semanticScholarQueries: ['s1'],
      githubQueries:          [{ q: 'g1', kind: 'repo' }, { q: 'g2', kind: 'code' }],
      openalexQueries:        ['oa1'],
      crossrefQueries:        ['cr1'],
      pubmedQueries:          ['pm1'],
    };
    const pack = await runOrchestrator(plan, fakeDeps());
    const groups = new Set(pack.sources.map(s => s.source));
    expect(groups.has('brave')).toBe(true);
    expect(groups.has('arxiv')).toBe(true);
    expect(groups.has('semantic_scholar')).toBe(true);
    expect(groups.has('github_repo')).toBe(true);
    expect(groups.has('github_code')).toBe(true);
    expect(groups.has('openalex')).toBe(true);
    expect(groups.has('crossref')).toBe(true);
    expect(groups.has('pubmed')).toBe(true);
  });

  it('routes brave_news endpoint to brave_news source group', async () => {
    const plan: QueryPlan = {
      ...emptyPlan,
      braveQueries: [{ q: 'earnings', endpoint: 'news', freshness: 'pw' }],
    };
    const pack = await runOrchestrator(plan, fakeDeps());
    expect(pack.sources.some(s => s.source === 'brave_news')).toBe(true);
  });

  it('prepends siteFilter to brave query string', async () => {
    let capturedQuery = '';
    const deps = fakeDeps();
    deps.brave.search = async (q) => { capturedQuery = q; return { results: [], keyIndex: 0, attempts: [] }; };
    const plan: QueryPlan = {
      ...emptyPlan,
      braveQueries: [{ q: 'regulation', siteFilter: 'site:sec.gov' }],
    };
    await runOrchestrator(plan, deps);
    expect(capturedQuery).toBe('site:sec.gov regulation');
  });

  it('passes freshness and endpoint options to brave.search', async () => {
    let capturedOpts: any = {};
    const deps = fakeDeps();
    deps.brave.search = async (q, opts) => { capturedOpts = opts; return { results: [], keyIndex: 0, attempts: [] }; };
    const plan: QueryPlan = {
      ...emptyPlan,
      braveQueries: [{ q: 'q', freshness: 'pm', endpoint: 'news' }],
    };
    await runOrchestrator(plan, deps);
    expect(capturedOpts.freshness).toBe('pm');
    expect(capturedOpts.endpoint).toBe('news');
    expect(capturedOpts.extraSnippets).toBe(true);
  });

  it('populates publishedAt from brave pageAge', async () => {
    const plan: QueryPlan = {
      ...emptyPlan,
      braveQueries: [{ q: 'q', freshness: 'pm' }],
    };
    const pack = await runOrchestrator(plan, fakeDeps());
    const braveSource = pack.sources.find(s => s.source === 'brave');
    expect(braveSource!.publishedAt).toBe('2026-01-01');
  });

  it('records failedAttempts when an adapter rejects', async () => {
    const deps = fakeDeps();
    deps.adapters.arxiv = async () => { throw new Error('rate_limited'); };
    const pack = await runOrchestrator(
      { ...emptyPlan, arxivQueries: ['x'] }, deps);
    expect(pack.failedAttempts.length).toBe(1);
    expect(pack.failedAttempts[0]!.reason).toBe('rate_limited');
  });

  it('skips disabled adapters', async () => {
    const deps = fakeDeps();
    deps.enabledAdapters = ['arxiv'];
    const plan: QueryPlan = { ...emptyPlan, openalexQueries: ['x'] };
    const pack = await runOrchestrator(plan, deps);
    expect(pack.sources.length).toBe(0);
    expect(pack.failedAttempts.length).toBe(1);
    expect(pack.failedAttempts[0]!.reason).toBe('no_api_key_configured');
  });

  it('enforces per-adapter concurrency limits (arxiv=1 sequential)', async () => {
    let maxConcurrent = 0;
    let current = 0;
    const deps = fakeDeps();
    deps.concurrencyCap = 8; // high global cap
    deps.adapters.arxiv = async (q) => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise(r => setTimeout(r, 50)); // simulate latency
      current--;
      return [{ adapterId: 'arxiv', recordId: '1', title: `A:${q}`, url: `https://a/${q}`, snippet: '', raw: {} }];
    };
    const plan: QueryPlan = {
      ...emptyPlan,
      arxivQueries: ['q1', 'q2', 'q3', 'q4'], // 4 concurrent arxiv queries
    };
    await runOrchestrator(plan, deps);
    expect(maxConcurrent).toBe(1); // arxiv concurrency limit is 1
  });

  it('records timeout as recoverable error without aborting fan-out', async () => {
    const deps = fakeDeps();
    deps.perAdapterTimeoutMs = 10; // very short timeout
    deps.adapters.openalex = async () => {
      await new Promise(r => setTimeout(r, 200)); // exceeds timeout
      return [];
    };
    const plan: QueryPlan = {
      ...emptyPlan,
      openalexQueries: ['slow-query'],
      arxivQueries: ['fast-query'],
    };
    const pack = await runOrchestrator(plan, deps);
    // arxiv should still succeed
    expect(pack.sources.some(s => s.source === 'arxiv')).toBe(true);
    // openalex should record a timeout failure
    expect(pack.failedAttempts.some(f => f.source === 'openalex' && f.reason.includes('timeout'))).toBe(true);
  });
});
