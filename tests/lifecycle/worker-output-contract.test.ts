import { describe, it, expect } from 'vitest';
import { parseWorkerOutput } from '../../packages/core/src/lifecycle/worker-output-contract.js';

// v5 — WorkerOutputSchema collapsed to 'done' | 'failed' (no done_with_concerns).
// See spec §5.3 and §8 (deletions).

describe('parseWorkerOutput (v5)', () => {
  it('extracts the last JSON code block', () => {
    const text = 'preamble\n```json\n{"summary":"old","workerSelfAssessment":"failed","filesChanged":[]}\n```\nmore\n```json\n{"summary":"new","workerSelfAssessment":"done","filesChanged":["a.ts"]}\n```';
    const out = parseWorkerOutput(text);
    expect(out.summary).toBe('new');
    expect(out.workerSelfAssessment).toBe('done');
    expect(out.filesChanged).toEqual(['a.ts']);
  });

  it('synthesizes failed output when no JSON block present', () => {
    const out = parseWorkerOutput('just chat, no JSON');
    expect(out.workerSelfAssessment).toBe('failed');
  });

  it('synthesizes failed output when JSON.parse throws', () => {
    const out = parseWorkerOutput('```json\n{"summary": "broken",\n```');
    expect(out.workerSelfAssessment).toBe('failed');
  });

  it('salvages to failed with summary preserved when schema-invalid but summary present', () => {
    const out = parseWorkerOutput('```json\n{"summary":"some text"}\n```');
    expect(out.summary).toBe('some text');
    // v5: salvage path emits 'failed' (no done_with_concerns hedging state).
    expect(out.workerSelfAssessment).toBe('failed');
  });
});
