// tests/reporting/research-report.test.ts
import { describe, expect, it } from 'vitest';
import { parseResearchReport } from '../../packages/core/src/reporting/report-parser-slots/research-report.js';

const sampleOutput = `# Research findings

1. Paper "Streaming JSON" (arxiv:2310.12345) describes a token-level pull parser. Source: arxiv.
2. simdjson README covers SIMD-accelerated parsing — https://github.com/simdjson/simdjson.
3. Per arxiv:2401.99999, lazy parsing avoids buffering.

## Sources used

| source | attempted | used | note |
| --- | --- | --- | --- |
| arxiv | yes | yes | 2 papers |
| simdjson README | yes | yes | github_search |
| brave-web | no | no | no Brave key |
`;

describe('parseResearchReport', () => {
  it('extracts numbered findings with bodies', () => {
    const r = parseResearchReport(sampleOutput);
    expect(r.findings).toHaveLength(3);
    expect(r.findings[0].body).toMatch(/Streaming JSON/);
    expect(r.findings[1].body).toMatch(/simdjson/);
  });

  it('extracts URL citations from finding bodies', () => {
    const r = parseResearchReport(sampleOutput);
    const citations = r.findings[1].citations;
    expect(citations.some(c => c.kind === 'url' && c.target?.includes('simdjson'))).toBe(true);
  });

  it('extracts source-name citations from the Sources Used table', () => {
    const r = parseResearchReport(sampleOutput);
    expect(r.findings[0].citations.some(c => c.kind === 'source' && c.label === 'arxiv')).toBe(true);
    expect(r.findings[2].citations.some(c => c.kind === 'source' && c.label === 'arxiv')).toBe(true);
  });

  it('parses the Sources Used table into structured rows', () => {
    const r = parseResearchReport(sampleOutput);
    expect(r.sourcesUsed).toHaveLength(3);
    const arxiv = r.sourcesUsed.find(s => s.source === 'arxiv');
    expect(arxiv).toMatchObject({ attempted: true, used: true, note: '2 papers' });
    const brave = r.sourcesUsed.find(s => s.source === 'brave-web');
    expect(brave).toMatchObject({ attempted: false, used: false });
  });

  it('returns empty arrays for an empty/malformed report', () => {
    const r = parseResearchReport('not a report');
    expect(r.findings).toEqual([]);
    expect(r.sourcesUsed).toEqual([]);
  });
});
