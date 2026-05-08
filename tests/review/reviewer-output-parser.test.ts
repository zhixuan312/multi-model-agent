import { describe, it, expect } from 'vitest';
import { ReviewerOutputParser } from '../../packages/core/src/review/reviewer-output-parser.js';

// Tool sweep #6 follow-up: the spec/quality reviewer prompt now says
// "Reply with JSON: {"verdict":"...","concerns":[...]}". Some models
// emit the JSON wrapped in ```json``` fences; others emit it bare. The
// parser must accept BOTH forms — otherwise the bare-JSON case falls
// through to the markdown-section path, never finds `## Summary`,
// defaults to `changes_required` with a meta-concern, and triggers the
// exact spec_rework spirals tool sweep #6 was designed to eliminate.

const parser = new ReviewerOutputParser();

describe('ReviewerOutputParser.parse — JSON paths', () => {
  it('extracts approved verdict from a fenced JSON block', () => {
    const text = '```json\n{"verdict":"approved","concerns":[]}\n```';
    expect(parser.parse(text)).toEqual({ verdict: 'approved', concerns: [] });
  });

  it('extracts approved verdict from BARE JSON (no fence)', () => {
    const text = '{"verdict":"approved","concerns":[]}';
    expect(parser.parse(text)).toEqual({ verdict: 'approved', concerns: [] });
  });

  it('extracts changes_required from bare JSON with concerns', () => {
    const text = '{"verdict":"changes_required","concerns":["missing X","wrong Y"]}';
    expect(parser.parse(text)).toEqual({
      verdict: 'changes_required',
      concerns: ['missing X', 'wrong Y'],
    });
  });

  it('handles bare JSON wrapped in light prose', () => {
    const text = 'Here is my review:\n{"verdict":"approved","concerns":[]}\nHope this helps.';
    expect(parser.parse(text).verdict).toBe('approved');
  });

  it('handles prose with its OWN braces preceding the JSON object', () => {
    // Prior parser tried firstBrace..lastBrace as a single slice, which
    // failed on this shape. Tool sweep #6 follow-up: balanced-brace walk.
    const text = 'The diff matches the brief {expected location} as requested.\n{"verdict":"approved","concerns":[]}';
    expect(parser.parse(text).verdict).toBe('approved');
  });

  it('handles JSON object embedded in a longer paragraph', () => {
    const text = 'Looking at the diff, the comment was added immediately above `export type FindingSeverity` as requested. The change is minimal and matches the brief verbatim, so I am approving. {"verdict":"approved","concerns":[]}';
    expect(parser.parse(text).verdict).toBe('approved');
  });

  it('extracts concerns array from JSON embedded in prose', () => {
    const text = 'Several issues:\n{"verdict":"changes_required","concerns":["missing test","unused import"]}\nPlease address.';
    const r = parser.parse(text);
    expect(r.verdict).toBe('changes_required');
    expect(r.concerns).toEqual(['missing test', 'unused import']);
  });

  it('handles JSON containing braces inside string values', () => {
    // Concerns array with JSON-in-string values — the balanced-brace
    // counter must respect string literals.
    const text = '{"verdict":"changes_required","concerns":["a {literal} brace inside a string","another {value}"]}';
    const r = parser.parse(text);
    expect(r.verdict).toBe('changes_required');
    expect(r.concerns).toEqual(['a {literal} brace inside a string', 'another {value}']);
  });

  it('case-insensitive verdict values (approve / APPROVED)', () => {
    expect(parser.parse('{"verdict":"approve","concerns":[]}').verdict).toBe('approved');
    expect(parser.parse('{"verdict":"APPROVED","concerns":[]}').verdict).toBe('approved');
    expect(parser.parse('{"verdict":"Changes_Required","concerns":["x"]}').verdict).toBe('changes_required');
  });

  it('maps "concerns" verdict to approved (parser convention)', () => {
    expect(parser.parse('{"verdict":"concerns","concerns":["minor nit"]}').verdict).toBe('approved');
  });
});

describe('ReviewerOutputParser.parse — markdown back-compat', () => {
  it('still extracts verdict from `## Summary` section (legacy format)', () => {
    const text = '## Summary\nThe diff fulfills the brief — approved.\n## Deviations from brief\n';
    expect(parser.parse(text).verdict).toBe('approved');
  });

  it('returns changes_required when summary mentions changes_required', () => {
    const text = '## Summary\nchanges_required: missing X.';
    expect(parser.parse(text).verdict).toBe('changes_required');
  });

  it('extracts concerns from `## Deviations from brief` bullets', () => {
    const text = `## Summary\napproved\n## Deviations from brief\n- missing license header\n- typo in comment`;
    const r = parser.parse(text);
    expect(r.concerns).toEqual(['missing license header', 'typo in comment']);
  });
});

describe('ReviewerOutputParser.parse — degraded paths', () => {
  it('returns changes_required + meta-concern when neither path produces a verdict', () => {
    const text = 'I think this looks fine, no changes needed.';
    const r = parser.parse(text);
    expect(r.verdict).toBe('changes_required');
    expect(r.concerns[0]).toMatch(/missing structured verdict/);
  });

  it('does not crash on empty input', () => {
    const r = parser.parse('');
    expect(r.verdict).toBe('changes_required');
  });

  it('does not crash on malformed JSON', () => {
    const r = parser.parse('{"verdict":');
    expect(r.verdict).toBe('changes_required');
  });
});

describe('ReviewerOutputParser.parseDiff', () => {
  it('extracts APPROVE verdict', () => {
    expect(parser.parseDiff('APPROVE')).toEqual({ verdict: 'approve', concerns: [] });
  });
  it('extracts CONCERNS: with reason', () => {
    expect(parser.parseDiff('CONCERNS: out-of-scope edit').verdict).toBe('concerns');
  });
  it('extracts REJECT: with reason', () => {
    expect(parser.parseDiff('REJECT: introduces a security issue').verdict).toBe('reject');
  });
  it('falls back to concerns + meta-concern when no marker', () => {
    const r = parser.parseDiff('looks ok i guess');
    expect(r.verdict).toBe('concerns');
    expect(r.concerns[0]).toMatch(/missing APPROVE \/ CONCERNS: \/ REJECT: marker/);
  });
});
