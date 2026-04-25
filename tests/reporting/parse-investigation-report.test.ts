// tests/reporting/parse-investigation-report.test.ts
import { parseCitations } from '../../packages/core/src/reporting/parse-investigation-report.js';

describe('parseCitations', () => {
  it('parses a simple bulleted citation with em-dash', () => {
    const r = parseCitations(['- src/auth/refresh.ts:45-72 — Refresh handler reads bearer.']);
    expect(r.citations).toEqual([{ file: 'src/auth/refresh.ts', lines: '45-72', claim: 'Refresh handler reads bearer.' }]);
    expect(r.malformedCitationLines).toBe(0);
  });

  it('parses asterisk bullets and double-dash separator', () => {
    const r = parseCitations(['* src/a.ts:1 -- claim text']);
    expect(r.citations).toEqual([{ file: 'src/a.ts', lines: '1', claim: 'claim text' }]);
  });

  it('parses no-bullet lines', () => {
    const r = parseCitations(['src/a.ts:1 — claim']);
    expect(r.citations.length).toBe(1);
  });

  it('parses numbered list bullets (1. and 1))', () => {
    const r = parseCitations(['1. src/a.ts:12 — claim a', '2) src/b.ts:13-15 -- claim b']);
    expect(r.citations.length).toBe(2);
  });

  it('handles paths containing colons (POSIX)', () => {
    const r = parseCitations(['src/foo:bar/file.ts:45 — claim']);
    expect(r.citations).toEqual([{ file: 'src/foo:bar/file.ts', lines: '45', claim: 'claim' }]);
  });

  it('handles Windows-style absolute paths', () => {
    const r = parseCitations(['C:\\repo\\src\\file.ts:45 — handles refresh']);
    expect(r.citations).toEqual([{ file: 'C:\\repo\\src\\file.ts', lines: '45', claim: 'handles refresh' }]);
  });

  it('rejects leading-zero line tokens', () => {
    const r = parseCitations(['- src/a.ts:001 — claim', '- src/b.ts:1-01 — claim']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(2);
  });

  it('rejects zero, negatives, and reversed ranges', () => {
    const r = parseCitations(['- src/a.ts:0 — c', '- src/b.ts:0-10 — c', '- src/c.ts:-5 — c', '- src/d.ts:20-10 — c']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(4);
  });

  it('rejects line tokens beyond MAX_SAFE_INTEGER', () => {
    const r = parseCitations(['- src/a.ts:99999999999999999999 — claim']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(1);
  });

  it('preserves the original lines token verbatim', () => {
    const r = parseCitations(['- src/a.ts:45-72 — c', '- src/b.ts:45 — c']);
    expect(r.citations.map(c => c.lines)).toEqual(['45-72', '45']);
  });

  it('rejects empty claims', () => {
    const r = parseCitations(['- src/a.ts:1 — ']);
    expect(r.citations).toEqual([]);
    expect(r.malformedCitationLines).toBe(1);
  });

  it('skips blank lines without counting them as malformed', () => {
    const r = parseCitations(['', '   ', '- src/a.ts:1 — c']);
    expect(r.citations.length).toBe(1);
    expect(r.malformedCitationLines).toBe(0);
  });
});