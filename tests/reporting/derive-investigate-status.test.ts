import { deriveInvestigateWorkerStatus, mapCapToReason } from '../../packages/core/src/reporting/derive-investigate-status.js';
import type { InvestigationParseResult } from '../../packages/core/src/reporting/parse-investigation-report.js';

function makeValidReport(): InvestigationParseResult {
  return {
    kind: 'structured_report',
    investigation: {
      citations: [{ file: 'a.ts', lines: '1', claim: 'c' }],
      confidence: { level: 'high', rationale: 'r' },
      needsCallerClarification: false,
      diagnostics: { malformedCitationLines: 0, missingRequiredSections: [], invalidRequiredSections: [] },
    },
    sectionValidity: { summary: 'valid', citations: 'valid', confidence: 'valid' },
  };
}
const noStructured: InvestigationParseResult = { kind: 'no_structured_report' };

describe('mapCapToReason', () => {
  it('maps cap kinds to reason names', () => {
    expect(mapCapToReason('turn')).toBe('turn_cap');
    expect(mapCapToReason('cost')).toBe('cost_cap');
    expect(mapCapToReason('wall_clock')).toBe('timeout');
  });
});

describe('deriveInvestigateWorkerStatus precedence', () => {
  it('rule 1: needsContext beats no_structured_report', () => {
    const r = deriveInvestigateWorkerStatus({ needsContext: true, parseResult: noStructured });
    expect(r).toEqual({ workerStatus: 'needs_context' });
  });

  it('rule 1: needsContext beats workerError', () => {
    const r = deriveInvestigateWorkerStatus({ needsContext: true, workerError: new Error('x'), parseResult: noStructured });
    expect(r.workerStatus).toBe('needs_context');
  });

  it('rule 2: workerError → blocked when no needsContext', () => {
    const r = deriveInvestigateWorkerStatus({ needsContext: false, workerError: new Error('x'), parseResult: noStructured });
    expect(r).toEqual({ workerStatus: 'blocked' });
  });

  it('rule 3: no_structured_report → blocked', () => {
    const r = deriveInvestigateWorkerStatus({ needsContext: false, parseResult: noStructured });
    expect(r).toEqual({ workerStatus: 'blocked' });
  });

  it('rule 4: structured_report with confidence invalid → done_with_concerns + missing_sections', () => {
    const r = deriveInvestigateWorkerStatus({
      needsContext: false,
      parseResult: { ...makeValidReport(), sectionValidity: { ...makeValidReport().sectionValidity, confidence: 'invalid' } },
    });
    expect(r).toEqual({ workerStatus: 'done_with_concerns', incompleteReason: 'missing_sections' });
  });

  it('rule 4: cap reason wins over missing_sections when both apply', () => {
    const r = deriveInvestigateWorkerStatus({
      needsContext: false,
      capExhausted: 'turn',
      parseResult: { ...makeValidReport(), sectionValidity: { ...makeValidReport().sectionValidity, confidence: 'invalid' } },
    });
    expect(r).toEqual({ workerStatus: 'done_with_concerns', incompleteReason: 'turn_cap' });
  });

  it('rule 5: cap with all sections valid → done_with_concerns + cap reason', () => {
    const r = deriveInvestigateWorkerStatus({ needsContext: false, capExhausted: 'wall_clock', parseResult: makeValidReport() });
    expect(r).toEqual({ workerStatus: 'done_with_concerns', incompleteReason: 'timeout' });
  });

  it('rule 6: all valid, no caps → done', () => {
    const r = deriveInvestigateWorkerStatus({ needsContext: false, parseResult: makeValidReport() });
    expect(r).toEqual({ workerStatus: 'done' });
  });

  it('done is allowed when citations are empty_legitimate (low confidence + (none))', () => {
    const r = deriveInvestigateWorkerStatus({
      needsContext: false,
      parseResult: { ...makeValidReport(), sectionValidity: { summary: 'valid', citations: 'empty_legitimate', confidence: 'valid' } },
    });
    expect(r).toEqual({ workerStatus: 'done' });
  });
});
