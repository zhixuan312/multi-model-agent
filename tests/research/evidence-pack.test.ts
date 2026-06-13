import {
  dedupSources, applyBudget, serializeEvidencePack,
  EVIDENCE_PACK_LIMITS, type EvidenceSource, type EvidencePack,
} from '../../packages/core/src/research/evidence-pack.js';

const mkSrc = (overrides: Partial<EvidenceSource> = {}): EvidenceSource => ({
  source: 'brave', query: 'q', title: 't', url: 'https://example.com/a',
  snippet: 's', rank: 0, ...overrides,
});

describe('evidence-pack', () => {
  it('dedups by URL preserving first occurrence per group priority', () => {
    const sources = [
      mkSrc({ source: 'brave',  url: 'https://x.com', title: 'B' }),
      mkSrc({ source: 'arxiv',  url: 'https://x.com', title: 'A' }),
      mkSrc({ source: 'brave',  url: 'https://y.com', title: 'B2' }),
    ];
    const out = dedupSources(sources);
    expect(out.find(s => s.url === 'https://x.com')?.source).toBe('arxiv');
    expect(out.length).toBe(2);
  });

  it('applies per-group cap of 10', () => {
    const sources = Array.from({ length: 15 }, (_, i) =>
      mkSrc({ source: 'brave', url: `https://b.com/${i}` }));
    const out = applyBudget(sources, []);
    expect(out.sources.filter(s => s.source === 'brave').length).toBe(10);
    expect(out.budgetExceeded).toBe(true);
  });

  it('truncates snippets longer than 500 chars with ellipsis', () => {
    const sources = [mkSrc({ snippet: 'x'.repeat(600) })];
    const out = applyBudget(sources, []);
    expect(out.sources[0]!.snippet.length).toBe(500 + 1);
    expect(out.sources[0]!.snippet.endsWith('…')).toBe(true);
  });

  it('caps total source count at 70', () => {
    const groups = ['arxiv','semantic_scholar','github_repo','github_code','brave','brave_news','openalex','crossref','pubmed'] as const;
    const sources: EvidenceSource[] = [];
    for (const g of groups) {
      for (let i = 0; i < 10; i++) sources.push(mkSrc({ source: g, url: `https://${g}/${i}` }));
    }
    const out = applyBudget(sources, []);
    expect(out.sources.length).toBeLessThanOrEqual(70);
    expect(out.budgetExceeded).toBe(true);
  });

  it('includes new source groups in dedup and budget', () => {
    const sources: EvidenceSource[] = [
      { source: 'openalex', query: 'q', title: 'OA1', url: 'https://oa/1', snippet: 'x', rank: 0 },
      { source: 'crossref', query: 'q', title: 'CR1', url: 'https://cr/1', snippet: 'x', rank: 0 },
      { source: 'pubmed', query: 'q', title: 'PM1', url: 'https://pm/1', snippet: 'x', rank: 0 },
      { source: 'brave_news', query: 'q', title: 'BN1', url: 'https://bn/1', snippet: 'x', rank: 0 },
    ];
    const pack = applyBudget(sources, []);
    expect(pack.sources.length).toBe(4);
    const groups = new Set(pack.sources.map(s => s.source));
    expect(groups.has('openalex')).toBe(true);
    expect(groups.has('crossref')).toBe(true);
    expect(groups.has('pubmed')).toBe(true);
    expect(groups.has('brave_news')).toBe(true);
  });

  it('drops brave_news before academic sources when over budget', () => {
    const sources: EvidenceSource[] = [];
    for (let i = 0; i < 15; i++) sources.push({ source: 'brave_news', query: 'q', title: `BN${i}`, url: `https://bn/${i}`, snippet: 'x'.repeat(400), rank: i });
    for (let i = 0; i < 15; i++) sources.push({ source: 'openalex', query: 'q', title: `OA${i}`, url: `https://oa/${i}`, snippet: 'x'.repeat(400), rank: i });
    const pack = applyBudget(sources, []);
    const braveNewsCount = pack.sources.filter(s => s.source === 'brave_news').length;
    const openalexCount = pack.sources.filter(s => s.source === 'openalex').length;
    expect(openalexCount).toBeGreaterThanOrEqual(braveNewsCount);
  });

  it('MAX_TOTAL_SOURCES is 70', () => {
    expect(EVIDENCE_PACK_LIMITS.MAX_TOTAL_SOURCES).toBe(70);
  });

  it('drops lowest-priority group first when bytes cap trips', () => {
    const fat = 'x'.repeat(4000);
    const sources: EvidenceSource[] = [];
    for (let i = 0; i < 6; i++) sources.push(mkSrc({ source: 'arxiv', url: `https://arxiv/${i}`, snippet: fat }));
    for (let i = 0; i < 6; i++) sources.push(mkSrc({ source: 'brave', url: `https://brave/${i}`, snippet: fat }));
    const out = applyBudget(sources, []);
    expect(out.sources.some(s => s.source === 'arxiv')).toBe(true);
    expect(out.sources.filter(s => s.source === 'brave').length)
      .toBeLessThan(6);
    expect(out.budgetExceeded).toBe(true);
  });

  it('serializeEvidencePack emits a sources section and failedAttempts section', () => {
    const pack: EvidencePack = {
      sources: [mkSrc({ title: 'Hello' })],
      failedAttempts: [{ source: 'semantic_scholar', query: 'q', reason: 'no_api_key_configured' }],
      generatedAt: new Date(0).toISOString(),
      totalQueries: 1,
      budgetExceeded: false,
    };
    const md = serializeEvidencePack(pack);
    expect(md).toMatch(/## Sources/);
    expect(md).toContain('Hello');
    expect(md).toMatch(/## Sources that failed/);
    expect(md).toContain('no_api_key_configured');
  });

  it('exposes limits as constants', () => {
    expect(EVIDENCE_PACK_LIMITS.MAX_TOTAL_BYTES).toBe(48 * 1024);
    expect(EVIDENCE_PACK_LIMITS.MAX_PER_GROUP).toBe(10);
    expect(EVIDENCE_PACK_LIMITS.MAX_SNIPPET_CHARS).toBe(500);
    expect(EVIDENCE_PACK_LIMITS.MAX_TOTAL_SOURCES).toBe(70);
  });
});
