import { describe, it, expect } from 'bun:test';
import {
  FINDINGS_OUTCOME_KINDS,
  findingsOutcomeKindSchema,
  inferFromFindings,
  aggregateOutcomes,
  type FindingsOutcomeKind,
} from '../../packages/core/src/reporting/findings-outcome.js';

describe('FindingsOutcomeKind enum + schema', () => {
  it('has exactly three values', () => {
    expect(FINDINGS_OUTCOME_KINDS).toEqual(['found', 'clean', 'not_applicable']);
  });
  it('schema validates valid + rejects invalid', () => {
    expect(findingsOutcomeKindSchema.parse('found')).toBe('found');
    expect(() => findingsOutcomeKindSchema.parse('failed')).toThrow();
  });
});

describe('inferFromFindings', () => {
  it('returns found when findings non-empty (regardless of legalOutcomes)', () => {
    expect(inferFromFindings([{ severity: 'high', category: 'c', claim: 'x' }] as any, ['found', 'clean'])).toBe('found');
  });
  it('returns clean for issue-hunter route with empty findings', () => {
    expect(inferFromFindings([], ['found', 'clean'])).toBe('clean');
  });
  it('returns not_applicable for answer-producer route with empty findings', () => {
    expect(inferFromFindings([], ['found', 'not_applicable'])).toBe('not_applicable');
  });
});

describe('aggregateOutcomes', () => {
  it('returns found if any input is found', () => {
    expect(aggregateOutcomes(['clean', 'found', 'not_applicable'])).toBe('found');
  });
  it('returns not_applicable if any input is not_applicable (and no found)', () => {
    expect(aggregateOutcomes(['clean', 'not_applicable', 'clean'])).toBe('not_applicable');
  });
  it('returns clean only when all inputs are clean', () => {
    expect(aggregateOutcomes(['clean', 'clean'])).toBe('clean');
  });
  it('throws on empty input', () => {
    expect(() => aggregateOutcomes([])).toThrow();
  });
});
