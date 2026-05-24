import { journalReportSchema } from '../../packages/core/src/reporting/report-parser-slots/journal-report.js';
describe('journal report parser', () => {
  it('extracts summary + filesChanged from fenced json', () => {
    const text = '```json\n{"summary":"created 0012","filesChanged":[".mmagent/journal/nodes/0012-x.md"]}\n```';
    const r = journalReportSchema.parse(text);
    expect(r.summary).toBe('created 0012');
    expect(r.filesChanged).toEqual(['.mmagent/journal/nodes/0012-x.md']);
  });
});
