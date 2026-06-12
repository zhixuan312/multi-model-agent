import { describe, it, expect } from 'vitest';
import { parseReviewerOutput } from '../../packages/core/src/unified/reviewer-output-parser.js';

describe('parseReviewerOutput', () => {
  it('parses fenced JSON', () => {
    const r = parseReviewerOutput('text\n```json\n{"findings":[],"summary":"ok","verdict":"approved"}\n```\nmore');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.verdict).toBe('approved');
  });

  it('parses bare JSON', () => {
    const r = parseReviewerOutput('{"findings":[{"severity":"high","category":"bug","description":"off by one","location":"f.ts:10","fix":"applied"}],"summary":"fixed","verdict":"changes_made"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.findings).toHaveLength(1);
      expect(r.data.verdict).toBe('changes_made');
    }
  });

  it('fails on prose-only output', () => {
    const r = parseReviewerOutput('Looks fine to me.');
    expect(r.ok).toBe(false);
  });

  it('fails on JSON missing verdict', () => {
    const r = parseReviewerOutput('{"findings":[],"summary":"ok"}');
    expect(r.ok).toBe(false);
  });

  it('fails on invalid severity enum', () => {
    const r = parseReviewerOutput('{"findings":[{"severity":"extreme","category":"a","description":"b","location":"c","fix":"applied"}],"summary":"ok","verdict":"approved"}');
    expect(r.ok).toBe(false);
  });
});
