import { describe, it, expect } from 'vitest';
import { ReviewerOutputParser } from '../../packages/core/src/engines/reviewer-output-parser.js';
import { AnnotatorOutputParser } from '../../packages/core/src/engines/annotator-output-parser.js';

describe('ReviewerOutputParser', () => {
  const p = new ReviewerOutputParser();

  it('parses approved verdict with empty findings', () => {
    const out = p.parse(
      '```json\n{"verdict":"approved","findings":[],"concernCategories":[],"findingsBySeverity":{"critical":0,"high":0,"medium":0,"low":0}}\n```',
    );
    expect(out.verdict).toBe('approved');
    expect(out.findings).toHaveLength(0);
    expect(out.concernCategories).toEqual([]);
    expect(out.findingsBySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('parses changes_required with findings and computes concernCategories from categories', () => {
    const out = p.parse(
      '```json\n{"verdict":"changes_required","findings":[{"severity":"high","category":"incomplete_impl","description":"Missing edge case","evidence":"src/foo.ts:42"}]}\n```',
    );
    expect(out.verdict).toBe('changes_required');
    expect(out.findings[0].severity).toBe('high');
    expect(out.findings[0].category).toBe('incomplete_impl');
    expect(out.concernCategories).toContain('incomplete_impl');
    expect(out.findingsBySeverity.high).toBe(1);
  });

  it('parses concerns verdict', () => {
    const out = p.parse('```json\n{"verdict":"concerns","findings":[]}\n```');
    expect(out.verdict).toBe('concerns');
  });

  it('tallies findingsBySeverity when not provided', () => {
    const out = p.parse(
      '```json\n{"verdict":"approved","findings":[{"severity":"critical","category":"a","description":"d","evidence":"e"},{"severity":"low","category":"b","description":"d2","evidence":"e2"}]}\n```',
    );
    expect(out.findingsBySeverity).toEqual({ critical: 1, high: 0, medium: 0, low: 1 });
  });

  it('rejects invalid verdict', () => {
    expect(() => p.parse('```json\n{"verdict":"maybe"}\n```')).toThrow(/verdict invalid/);
  });

  it('throws on missing JSON block', () => {
    expect(() => p.parse('no json here')).toThrow(/missing JSON block/);
  });
});

describe('AnnotatorOutputParser', () => {
  const p = new AnnotatorOutputParser();

  it('parses annotated findings', () => {
    const out = p.parse(
      '```json\n{"findings":[{"id":"F1","severity":"critical","claim":"a-claim","evidence":"line 5","annotatorConfidence":90}]}\n```',
    );
    expect(out.verdict).toBe('annotated');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].id).toBe('F1');
  });

  it('returns error verdict on missing JSON block', () => {
    expect(p.parse('no json here').verdict).toBe('error');
  });

  it('defaults findings to empty array when missing', () => {
    const out = p.parse('```json\n{"verdict":"annotated"}\n```');
    expect(out.verdict).toBe('annotated');
    expect(out.findings).toEqual([]);
  });
});
