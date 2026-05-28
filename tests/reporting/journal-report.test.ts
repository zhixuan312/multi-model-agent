import { journalReportSchema } from '../../packages/core/src/reporting/report-parser-slots/journal-report.js';

describe('journal report parser', () => {
  it('extracts summary, filesChanged, recorded and failed', () => {
    const text = '```json\n' + JSON.stringify({
      summary: 'recorded 2, failed 1',
      filesChanged: ['.mmagent/journal/nodes/0012-x.md', 'index.md', 'log.md'],
      recorded: [{ learningIndex: 0, op: 'create', ids: ['0012'] }, { learningIndex: 1, op: 'refine', ids: ['0009'] }],
      failed: [{ learningIndex: 2, learning: 'bad one', reason: 'ambiguous, no related node' }],
    }) + '\n```';
    const r = journalReportSchema.parse(text);
    expect(r.summary).toBe('recorded 2, failed 1');
    expect(r.filesChanged).toContain('index.md');
    expect(r.recorded).toHaveLength(2);
    expect(r.recorded[0]).toEqual({ learningIndex: 0, op: 'create', ids: ['0012'] });
    expect(r.failed[0].learningIndex).toBe(2);
  });
  it('defaults recorded/failed to empty arrays when absent', () => {
    const r = journalReportSchema.parse('```json\n{"summary":"x","filesChanged":[]}\n```');
    expect(r.recorded).toEqual([]);
    expect(r.failed).toEqual([]);
  });
});
