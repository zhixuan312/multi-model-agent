import { describe, it, expect } from 'vitest';
import { BatchCompletedEvent } from '../../../packages/core/src/events/observability-events.js';

describe('batch_completed grouping fields', () => {
  it('parses an event with the three new optional fields', () => {
    const parsed = BatchCompletedEvent.parse({
      event: 'batch_completed',
      ts: new Date().toISOString(),
      batchId: '550e8400-e29b-41d4-a716-446655440000',
      tool: 'delegate',
      durationMs: 1000,
      taskCount: 3,
      groupCount: 1,
      groupSizes: [3],
      serializationApplied: true,
    });
    expect(parsed.groupCount).toBe(1);
    expect(parsed.groupSizes).toEqual([3]);
    expect(parsed.serializationApplied).toBe(true);
  });

  it('parses an event WITHOUT the three new fields (back-compat)', () => {
    const parsed = BatchCompletedEvent.parse({
      event: 'batch_completed',
      ts: new Date().toISOString(),
      batchId: '550e8400-e29b-41d4-a716-446655440000',
      tool: 'audit',
      durationMs: 500,
      taskCount: 1,
    });
    expect(parsed.groupCount).toBeUndefined();
    expect(parsed.groupSizes).toBeUndefined();
    expect(parsed.serializationApplied).toBeUndefined();
  });

  it('rejects unknown fields (strict schema preservation)', () => {
    expect(() => BatchCompletedEvent.parse({
      event: 'batch_completed',
      ts: new Date().toISOString(),
      batchId: '550e8400-e29b-41d4-a716-446655440000',
      tool: 'delegate',
      durationMs: 100,
      taskCount: 1,
      unknownField: 'oops',
    })).toThrow();
  });
});
