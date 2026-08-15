import { describe, expect, it } from 'vitest';
import { runOrchestrator, type OrchestratorDeps } from '../../packages/core/src/research/orchestrator.js';
import { parseQueryPlan } from '../../packages/core/src/research/query-plan.js';
import { EVIDENCE_PACK_LIMITS } from '../../packages/core/src/research/evidence-pack.js';
import type { AdapterResult } from '../../packages/core/src/research/adapters/types.js';

function makeResult(adapterId: string, prefix: string, count: number): AdapterResult[] {
  return Array.from({ length: count }, (_, i) => ({
    adapterId: adapterId as any,
    recordId: `${prefix}-${i}`,
    title: `${prefix} result ${i}`,
    url: `https://${prefix}.example.com/${i}`,
    snippet: `Snippet for ${prefix} ${i}`.repeat(5),
    publishedAt: '2026-01-01',
    raw: {},
  }));
}

describe('research integration: full plan -> fan-out -> evidence-pack (all 9 source groups)', () => {
  const allDeps = (): OrchestratorDeps => ({
    enabledAdapters: ['arxiv', 'semantic_scholar', 'github_search', 'openalex', 'crossref', 'pubmed'],
    brave: {
      search: async (q, opts) => ({
        results: Array.from({ length: 5 }, (_, i) => ({
          title: `Brave ${opts?.endpoint ?? 'web'} ${i}`,
          url: `https://brave-${opts?.endpoint ?? 'web'}.example.com/${i}`,
          snippet: `Brave snippet ${i}`,
          pageAge: '2026-06-01',
          extraSnippets: [`extra ${i}`],
        })),
        keyIndex: 0,
        attempts: [],
      }),
    },
    adapters: {
      arxiv:           async (q) => makeResult('arxiv', 'arxiv', 5),
      semanticScholar: async (q) => makeResult('semantic_scholar', 'ss', 5),
      github:          async (q, kind) => makeResult('github_search', `gh-${kind}`, 5),
      openalex:        async (q) => makeResult('openalex', 'oa', 5),
      crossref:        async (q) => makeResult('crossref', 'cr', 5),
      pubmed:          async (q) => makeResult('pubmed', 'pm', 5),
    },
    perAdapterTimeoutMs: 5000,
    totalDeadlineMs:     30_000,
    concurrencyCap:      8,
  });

  it('exercises all 9 source groups through query-plan -> orchestrator -> evidence-pack', async () => {
    // Parse a plan that hits all 9 source groups (brave, brave_news, arxiv,
    // semantic_scholar, github_repo, github_code, openalex, crossref, pubmed)
    const plan = parseQueryPlan(JSON.stringify({
      braveQueries:           [{ q: 'web query' }, { q: 'news query', endpoint: 'news', freshness: 'pw' }],
      arxivQueries:           ['arxiv query'],
      semanticScholarQueries: ['ss query'],
      githubQueries:          [{ q: 'repo query', kind: 'repo' }, { q: 'code query', kind: 'code' }],
      openalexQueries:        ['openalex query'],
      crossrefQueries:        ['crossref query'],
      pubmedQueries:          ['pubmed query'],
    }));

    const pack = await runOrchestrator(plan, allDeps());

    // All 9 source groups must be represented
    const groups = new Set(pack.sources.map(s => s.source));
    expect(groups.size).toBe(9);
    expect(groups).toEqual(new Set([
      'brave', 'brave_news', 'arxiv', 'semantic_scholar',
      'github_repo', 'github_code', 'openalex', 'crossref', 'pubmed',
    ]));

    // No failures
    expect(pack.failedAttempts.length).toBe(0);
    // 9 groups x 5 results = 45, under every cap — so this case exercises the untrimmed path,
    // and the trimmed path is the next case's job. Stated so the two are not confused.
    expect(pack.budgetExceeded).toBe(false);

    // Budget caps are respected
    expect(pack.sources.length).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_TOTAL_SOURCES);
    const totalBytes = pack.sources.reduce((sum, s) => sum + Buffer.byteLength(JSON.stringify(s), 'utf8'), 0);
    expect(totalBytes).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_TOTAL_BYTES);

    // Per-group cap is respected
    for (const group of groups) {
      const count = pack.sources.filter(s => s.source === group).length;
      expect(count).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_PER_GROUP);
    }
  });

  it('respects budget caps when all 9 groups return maximum results', async () => {
    const deps = allDeps();
    // Each adapter returns 10 results with long snippets to trigger budget trimming
    deps.adapters.arxiv = async () => makeResult('arxiv', 'arxiv', 10);
    deps.adapters.semanticScholar = async () => makeResult('semantic_scholar', 'ss', 10);
    deps.adapters.github = async (q, kind) => makeResult('github_search', `gh-${kind}`, 10);
    deps.adapters.openalex = async () => makeResult('openalex', 'oa', 10);
    deps.adapters.crossref = async () => makeResult('crossref', 'cr', 10);
    deps.adapters.pubmed = async () => makeResult('pubmed', 'pm', 10);
    deps.brave.search = async (q, opts) => ({
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `Brave ${i}`, url: `https://b/${i}`,
        snippet: 'x'.repeat(400), pageAge: '2026-01-01',
      })),
      keyIndex: 0, attempts: [],
    });

    const plan = parseQueryPlan(JSON.stringify({
      braveQueries:           [{ q: 'q1' }, { q: 'q2', endpoint: 'news' }],
      arxivQueries:           ['q'], semanticScholarQueries: ['q'],
      githubQueries:          [{ q: 'q', kind: 'repo' }, { q: 'q', kind: 'code' }],
      openalexQueries:        ['q'], crossrefQueries: ['q'], pubmedQueries: ['q'],
    }));

    const pack = await runOrchestrator(plan, deps);

    // The cap holding is only half the claim, and the weaker half: 9 groups capped at 10 each is
    // 90 raw sources against a limit of 70, so trimming MUST have engaged. Asserting only
    // `length <= MAX_TOTAL_SOURCES` would also pass if trimming silently stopped happening and
    // the adapters simply returned fewer results — the exact regression this case is named for.
    expect(pack.budgetExceeded, 'trimming did not engage on an over-budget pack').toBe(true);
    expect(pack.sources.length).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_TOTAL_SOURCES);

    // The long snippets exist to push the BYTE budget, which nothing here checked. Both caps are
    // enforced by the same trimming pass and either can be the one that binds.
    const totalBytes = pack.sources.reduce(
      (sum, source) => sum + Buffer.byteLength(JSON.stringify(source), 'utf8'), 0);
    expect(totalBytes).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_TOTAL_BYTES);

    // …and no single snippet outlives the per-snippet cap that makes the byte budget reachable.
    for (const source of pack.sources) {
      expect((source.snippet ?? '').length).toBeLessThanOrEqual(EVIDENCE_PACK_LIMITS.MAX_SNIPPET_CHARS);
    }
  });
});
