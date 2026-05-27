// tests/reporting/research-report.test.ts
//
// v4.4.x: research findings are parsed by the shared `## Finding N:` parser
// (parseFindings); this slot only owns the research-specific `## Sources used`
// markdown table extractor.
import { describe, expect, it } from 'bun:test';
import {
  parseSourcesUsed,
  researchReportSchema,
} from '../../packages/core/src/reporting/report-parser-slots/research-report.js';

const sampleSourcesBlock = `Some preamble.

## Sources used

| source | attempted | used | note |
| --- | --- | --- | --- |
| arxiv | yes | yes | 2 papers |
| simdjson README | yes | yes | github_search |
| brave-web | no | no | no Brave key |
`;

describe('parseSourcesUsed', () => {
  it('parses the Sources Used table into structured rows', () => {
    const rows = parseSourcesUsed(sampleSourcesBlock);
    expect(rows).toHaveLength(3);
    const arxiv = rows.find(s => s.source === 'arxiv');
    expect(arxiv).toMatchObject({ attempted: true, used: true, note: '2 papers' });
    const brave = rows.find(s => s.source === 'brave-web');
    expect(brave).toMatchObject({ attempted: false, used: false });
  });

  it('returns [] when there is no Sources used section', () => {
    expect(parseSourcesUsed('not a report')).toEqual([]);
  });

  it('is case-insensitive on the section heading', () => {
    const text = `## SOURCES USED

| source | attempted | used |
| --- | --- | --- |
| arxiv | yes | yes |
`;
    expect(parseSourcesUsed(text)).toHaveLength(1);
  });

  it('skips malformed rows (fewer than 3 cells)', () => {
    const text = `## Sources used

| source | attempted |
| --- | --- |
| arxiv | yes |
`;
    expect(parseSourcesUsed(text)).toEqual([]);
  });

  it('stops at the next ## section heading', () => {
    const text = `## Sources used

| source | attempted | used |
| --- | --- | --- |
| arxiv | yes | yes |

## Other section

| source | attempted | used |
| --- | --- | --- |
| should-not-appear | yes | yes |
`;
    const rows = parseSourcesUsed(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('arxiv');
  });
});

describe('researchReportSchema (fallback ReportSchema parse)', () => {
  it('returns sources table; findings empty in this fallback path', () => {
    const out = researchReportSchema.parse(sampleSourcesBlock);
    expect(out.findings).toEqual([]);
    expect(out.sourcesUsed).toHaveLength(3);
  });
});
