import { describe, it, expect } from 'vitest';
import { parseWorkerOutput } from '../../packages/core/src/lifecycle/worker-output-contract.js';

describe('parseWorkerOutput', () => {
  it('extracts the last JSON code block', () => {
    const text = 'preamble\n```json\n{"summary":"old","workerStatus":"failed","filesChanged":[],"validationsRun":[],"unresolved":[]}\n```\nmore\n```json\n{"summary":"new","workerStatus":"done","filesChanged":["a.ts"],"validationsRun":[],"unresolved":[]}\n```';
    const out = parseWorkerOutput(text);
    expect(out.summary).toBe('new');
    expect(out.workerStatus).toBe('done');
    expect(out.filesChanged).toEqual(['a.ts']);
  });

  it('synthesizes failed output when no JSON block present', () => {
    const out = parseWorkerOutput('just chat, no JSON');
    expect(out.workerStatus).toBe('failed');
    expect(out.unresolved).toContain('no structured output emitted');
  });

  it('synthesizes failed output when JSON.parse throws', () => {
    const out = parseWorkerOutput('```json\n{"summary": "broken",\n```');
    expect(out.workerStatus).toBe('failed');
    expect(out.unresolved[0]).toMatch(/not valid JSON/);
  });

  it('downgrades to done_with_concerns when schema-invalid but summary present', () => {
    const out = parseWorkerOutput('```json\n{"summary":"some text"}\n```');
    expect(out.summary).toBe('some text');
    expect(out.workerStatus).toBe('done_with_concerns');
    expect(out.unresolved.length).toBeGreaterThan(0);
  });

  it('preserves commitMessage when supplied', () => {
    const text = '```json\n{"summary":"ok","workerStatus":"done","filesChanged":[],"validationsRun":[],"unresolved":[],"commitMessage":"feat: thing"}\n```';
    const out = parseWorkerOutput(text);
    expect(out.commitMessage).toBe('feat: thing');
  });
});
