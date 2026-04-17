import { describe, it, expect } from 'vitest';
import { buildClarificationAwareResponse } from '../../packages/mcp/src/clarification-response.js';

describe('clarification-response', () => {
  it('returns v2.1.0 schemaVersion', () => {
    const response = buildClarificationAwareResponse({
      batchId: 'batch-1',
      results: [],
      clarifications: [],
      intakeProgress: { totalDrafts: 0, readyDrafts: 0, clarificationDrafts: 0, hardErrorDrafts: 0, executedDrafts: 0 },
    });
    expect(response.schemaVersion).toBe('2.1.0');
  });

  it('includes clarificationId when provided', () => {
    const response = buildClarificationAwareResponse({
      batchId: 'batch-1',
      results: [],
      clarifications: [],
      intakeProgress: { totalDrafts: 1, readyDrafts: 0, clarificationDrafts: 1, hardErrorDrafts: 0, executedDrafts: 0 },
      clarificationId: 'clar-123',
    });
    expect(response.clarificationId).toBe('clar-123');
    expect(response.originalBatchId).toBeUndefined();
  });

  it('includes originalBatchId when provided', () => {
    const response = buildClarificationAwareResponse({
      batchId: 'batch-2',
      results: [],
      clarifications: [],
      intakeProgress: { totalDrafts: 0, readyDrafts: 0, clarificationDrafts: 0, hardErrorDrafts: 0, executedDrafts: 0 },
      originalBatchId: 'batch-1',
    });
    expect(response.originalBatchId).toBe('batch-1');
  });
});