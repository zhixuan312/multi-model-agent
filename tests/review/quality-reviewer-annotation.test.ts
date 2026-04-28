import { describe, it, expect } from 'vitest';
import {
  extractWorkerFindings,
  parseAndMergeAnnotations,
} from '../../packages/core/src/review/quality-reviewer.js';
import type { WorkerFinding } from '../../packages/core/src/executors/_shared/findings-schema.js';

const VALID_EVIDENCE = 'src/auth/login.ts:89 — the property access is unguarded against undefined req.body.user';

const sampleWorkerFindings: WorkerFinding[] = [
  { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE },
  { id: 'F2', severity: 'medium', claim: 'b', evidence: VALID_EVIDENCE, suggestion: 'wrap it' },
];

describe('extractWorkerFindings', () => {
  it('extracts a valid findings array from a json fenced block', () => {
    const out = JSON.stringify(sampleWorkerFindings);
    const wrapped = `Some prose.\n\n\`\`\`json\n${out}\n\`\`\`\n\nMore prose.`;
    const found = extractWorkerFindings(wrapped);
    expect(found).toEqual(sampleWorkerFindings);
  });

  it('returns null when no json block present', () => {
    expect(extractWorkerFindings('No code blocks here.')).toBeNull();
  });

  it('returns null when json block content fails the schema', () => {
    const bad = '```json\n[{"id":"F1","severity":"INVALID"}]\n```';
    expect(extractWorkerFindings(bad)).toBeNull();
  });

  it('skips invalid json blocks and returns the first valid one', () => {
    const out = JSON.stringify(sampleWorkerFindings);
    const text = `Example:\n\`\`\`json\n{"not": "an array"}\n\`\`\`\n\nReal:\n\`\`\`json\n${out}\n\`\`\``;
    expect(extractWorkerFindings(text)).toEqual(sampleWorkerFindings);
  });

  it('accepts an empty findings array', () => {
    expect(extractWorkerFindings('```json\n[]\n```')).toEqual([]);
  });
});

describe('parseAndMergeAnnotations', () => {
  it('merges valid annotation array with worker findings', () => {
    const annotations = JSON.stringify([
      { id: 'F1', reviewerConfidence: 85 },
      { id: 'F2', reviewerConfidence: 40, reviewerSeverity: 'low' },
    ]);
    const reviewerOutput = `Reviewing.\n\n\`\`\`json\n${annotations}\n\`\`\``;
    const result = parseAndMergeAnnotations(reviewerOutput, sampleWorkerFindings);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.annotated).toEqual([
      { id: 'F1', severity: 'high', claim: 'a', evidence: VALID_EVIDENCE, reviewerConfidence: 85 },
      { id: 'F2', severity: 'medium', claim: 'b', evidence: VALID_EVIDENCE, suggestion: 'wrap it', reviewerConfidence: 40, reviewerSeverity: 'low' },
    ]);
  });

  it('errors when reviewer output has no json block', () => {
    const result = parseAndMergeAnnotations('No fence here.', sampleWorkerFindings);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/missing.*json/);
  });

  it('errors on out-of-range reviewerConfidence', () => {
    const annotations = '```json\n[{"id":"F1","reviewerConfidence":150},{"id":"F2","reviewerConfidence":50}]\n```';
    const result = parseAndMergeAnnotations(annotations, sampleWorkerFindings);
    expect(result.ok).toBe(false);
  });

  it('errors when annotation count differs from worker findings count', () => {
    const annotations = '```json\n[{"id":"F1","reviewerConfidence":50}]\n```';
    const result = parseAndMergeAnnotations(annotations, sampleWorkerFindings);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/count/);
  });

  it('errors on duplicate id in annotation array', () => {
    const annotations = '```json\n[{"id":"F1","reviewerConfidence":50},{"id":"F1","reviewerConfidence":60}]\n```';
    const result = parseAndMergeAnnotations(annotations, sampleWorkerFindings);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/duplicate/);
  });

  it('errors on hallucinated id (reviewer adds id not in worker)', () => {
    const annotations = '```json\n[{"id":"F1","reviewerConfidence":50},{"id":"F99","reviewerConfidence":60}]\n```';
    const result = parseAndMergeAnnotations(annotations, sampleWorkerFindings);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unknown id|missing annotation/);
  });

  it('errors on missing id (reviewer drops a worker finding)', () => {
    const annotations = '```json\n[{"id":"F1","reviewerConfidence":50},{"id":"F3","reviewerConfidence":60}]\n```';
    const result = parseAndMergeAnnotations(annotations, sampleWorkerFindings);
    expect(result.ok).toBe(false);
  });

  it('errors when reviewer block is malformed JSON', () => {
    const annotations = '```json\n[{not valid json}]\n```';
    const result = parseAndMergeAnnotations(annotations, sampleWorkerFindings);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/JSON parse failed/);
  });
});
