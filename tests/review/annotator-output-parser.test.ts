import { describe, it, expect } from 'vitest';
import { AnnotatorOutputParser } from '../../packages/core/src/review/annotator-output-parser.js';

const parser = new AnnotatorOutputParser();

// Tool sweep #12 follow-up: the annotator-output parser was too strict
// (only ```json fenced```), causing verify's PASS findings to land as
// `annotated: 0` in wire telemetry. New parser handles three shapes.

describe('AnnotatorOutputParser.parse', () => {
  it('extracts findings from fenced ```json``` block (legacy)', () => {
    const text = '```json\n[{"id":"F1","severity":"low","claim":"a","evidence":"e","annotatorConfidence":80}]\n```';
    const r = parser.parse({ finalAssistantText: text });
    expect(r.verdict).toBe('annotated');
    expect(r.annotatedFindings).toHaveLength(1);
  });

  it('extracts findings from fenced ``` block (no language tag)', () => {
    const text = '```\n[{"id":"F1","severity":"low","claim":"a","evidence":"e"}]\n```';
    const r = parser.parse({ finalAssistantText: text });
    expect(r.verdict).toBe('annotated');
    expect(r.annotatedFindings).toHaveLength(1);
  });

  it('extracts findings from BARE JSON array (no fence)', () => {
    const text = '[{"id":"F1","severity":"low","claim":"a","evidence":"e"}]';
    const r = parser.parse({ finalAssistantText: text });
    expect(r.verdict).toBe('annotated');
    expect(r.annotatedFindings).toHaveLength(1);
  });

  it('extracts findings array from prose-wrapped output', () => {
    const text = `I reviewed the worker's output. Here are the structured findings:\n\n[{"id":"F1","severity":"low","claim":"a","evidence":"e"}, {"id":"F2","severity":"medium","claim":"b","evidence":"e"}]\n\nThat's all I have.`;
    const r = parser.parse({ finalAssistantText: text });
    expect(r.verdict).toBe('annotated');
    expect(r.annotatedFindings).toHaveLength(2);
  });

  it('handles empty array (worker had no findings)', () => {
    const r = parser.parse({ finalAssistantText: '[]' });
    expect(r.verdict).toBe('annotated');
    expect(r.annotatedFindings).toEqual([]);
  });

  it('handles arrays with brackets inside string values', () => {
    const text = '[{"id":"F1","severity":"low","claim":"saw [literal] inside string","evidence":"e"}]';
    const r = parser.parse({ finalAssistantText: text });
    expect(r.verdict).toBe('annotated');
    expect(r.annotatedFindings).toHaveLength(1);
  });

  it('returns error when no parseable JSON array found', () => {
    const r = parser.parse({ finalAssistantText: 'I think the worker did fine but I cannot extract findings.' });
    expect(r.verdict).toBe('error');
    expect(r.annotatedFindings).toEqual([]);
  });

  it('returns error on missing finalAssistantText', () => {
    const r = parser.parse({ finalAssistantText: undefined });
    expect(r.verdict).toBe('error');
  });

  it('extracts inner array from a wrapping object (lenient — finds `[...]` anywhere)', () => {
    const text = '{"results": [{"id":"F1","severity":"low","claim":"a","evidence":"e"}]}';
    const r = parser.parse({ finalAssistantText: text });
    // The lenient parser walks every `[` — including ones inside an
    // outer object — so it correctly recovers the array. Models that
    // wrap the array in `{"results": [...]}` no longer get rejected.
    expect(r.verdict).toBe('annotated');
    expect(r.annotatedFindings).toHaveLength(1);
  });
});
