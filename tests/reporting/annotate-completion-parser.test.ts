import { describe, it, expect } from 'vitest';
import { parseAnnotatorOutput } from '../../packages/core/src/reporting/annotate-completion-parser.js';

describe('parseAnnotatorOutput', () => {
  it('extracts a valid fenced JSON block', () => {
    const out = '```json\n{"completionPercent":85,"perStep":[{"step":"S1","status":"done","note":null}],"concerns":[]}\n```';
    const r = parseAnnotatorOutput(out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.completionPercent).toBe(85);
    expect(r.value.perStep).toHaveLength(1);
    expect(r.value.perStep[0]?.step).toBe('S1');
  });

  it('rejects when no fenced block', () => {
    const r = parseAnnotatorOutput('no fences here, just prose with {"completionPercent":85} embedded');
    expect(r.ok).toBe(false);
  });

  it('rejects when JSON parse fails', () => {
    const r = parseAnnotatorOutput('```json\n{not valid json\n```');
    expect(r.ok).toBe(false);
  });

  it('rejects when completionPercent out of range', () => {
    const out = '```json\n{"completionPercent":150,"perStep":[],"concerns":[]}\n```';
    const r = parseAnnotatorOutput(out);
    expect(r.ok).toBe(false);
  });

  it('rejects when perStep entry has bad status', () => {
    const out = '```json\n{"completionPercent":50,"perStep":[{"step":"X","status":"flaky","note":null}],"concerns":[]}\n```';
    const r = parseAnnotatorOutput(out);
    expect(r.ok).toBe(false);
  });

  it('accepts prose around the fence and extracts the first block', () => {
    const out = 'Here is the annotation:\n```json\n{"completionPercent":90,"perStep":[],"concerns":["foo"]}\n```\n(end of report)';
    const r = parseAnnotatorOutput(out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.completionPercent).toBe(90);
    expect(r.value.concerns).toEqual(['foo']);
  });

  it('accepts perStep with `partial` and `missing` status values', () => {
    const out = '```json\n{"completionPercent":40,"perStep":[{"step":"A","status":"done","note":null},{"step":"B","status":"partial","note":"TODO"},{"step":"C","status":"missing","note":null}],"concerns":[]}\n```';
    const r = parseAnnotatorOutput(out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.perStep.map(s => s.status)).toEqual(['done', 'partial', 'missing']);
  });
});
