import { describe, it, expect } from 'vitest';
import { renderTerminalReportMarkdown } from '../../packages/core/src/reporting/terminal-report-markdown.js';

const base = {
  route: 'audit',
  status: 'done_with_concerns',
  headline: { prefix: 'audit: 1 task complete', stageLabel: 'terminal', stageIndex: 3, stageTotal: 3, toolWrites: 0, toolTotal: 5 },
};

describe('renderTerminalReportMarkdown', () => {
  it('includes route, status, headline, and every finding field', () => {
    const md = renderTerminalReportMarkdown({
      ...base,
      findings: [
        { id: 'F1', severity: 'high', category: 'coherence', claim: 'Claim one', evidence: 'ev one', suggestion: 'fix one' },
        { id: 'F2', severity: 'low', category: 'style', claim: 'Claim two', evidence: 'ev two', suggestion: 'fix two' },
      ],
    } as any);
    expect(md).toContain('audit');
    expect(md).toContain('done_with_concerns');
    expect(md).toContain('audit: 1 task complete');
    for (const s of ['F1', 'high', 'coherence', 'Claim one', 'ev one', 'fix one',
                     'F2', 'low', 'style', 'Claim two', 'ev two', 'fix two']) {
      expect(md).toContain(s);
    }
  });

  it('emits a non-empty block for zero findings (title + headline)', () => {
    const md = renderTerminalReportMarkdown({ ...base, status: 'done', findings: [] } as any);
    expect(md).toContain('audit');
    expect(md).toContain('done');
    expect(md.trim().length).toBeGreaterThan(0);
    expect(md).toMatch(/no findings/i);
  });
});
