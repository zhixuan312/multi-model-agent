import { describe, it, expect } from 'vitest';
import { aggregateResult } from '@zhixuan92/multi-model-agent-core/review/aggregate-result';
import type { ParsedStructuredReport } from '@zhixuan92/multi-model-agent-core';

const implReport: ParsedStructuredReport = {
  summary: 'Swapped auth to JWT.',
  filesChanged: [{ path: 'src/auth.ts', summary: 'JWT impl' }],
  normalizationDecisions: [['Resolved users.ts pattern']],
  validationsRun: [{ command: 'tsc', result: 'passed' }],
  deviationsFromBrief: [],
  unresolved: [],
};

const specReport: ParsedStructuredReport = {
  summary: 'approved',
  filesChanged: [],
  normalizationDecisions: [],
  validationsRun: [{ command: 'scope check', result: 'passed' }],
  deviationsFromBrief: [],
  unresolved: [],
};

const qualityReport: ParsedStructuredReport = {
  summary: 'approved',
  filesChanged: [],
  normalizationDecisions: [],
  validationsRun: [{ command: 'null safety check', result: 'passed' }],
  deviationsFromBrief: [],
  unresolved: [],
};

describe('aggregateResult', () => {
  it('merges all three reports with [Reviewed] prefix', () => {
    const r = aggregateResult(implReport, specReport, qualityReport, 'approved', 'approved');
    expect(r.summary).toContain('[Reviewed]');
    expect(r.summary).toContain('Swapped auth to JWT');
    expect(r.filesChanged).toHaveLength(1);
    expect(r.validationsRun).toHaveLength(3);
    expect(r.normalizationDecisions).toHaveLength(1);
  });

  it('prefixes with [Spec review exhausted] when spec exhausted', () => {
    const r = aggregateResult(implReport, specReport, undefined, 'changes_required', 'not_run');
    expect(r.summary).toContain('[Spec review exhausted]');
  });

  it('prefixes with [Quality review exhausted] when quality exhausted', () => {
    const r = aggregateResult(implReport, specReport, qualityReport, 'approved', 'changes_required');
    expect(r.summary).toContain('[Quality review exhausted]');
  });

  it('handles undefined quality report (not_run)', () => {
    const r = aggregateResult(implReport, specReport, undefined, 'approved', 'not_run');
    expect(r.summary).toContain('[Reviewed]');
    expect(r.validationsRun).toHaveLength(2);
  });
});