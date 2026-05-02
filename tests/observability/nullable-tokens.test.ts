import { describe, it, expect } from 'vitest';
import { TaskCompletedLocalEvent, TurnCompleteEvent } from '../../packages/core/src/observability/events.js';

describe('observability event schemas — nullable cachedTokens/reasoningTokens', () => {
  const baseTaskFields = {
    ts: '2026-05-01T00:00:00.000Z',
    batchId: '12345678-1234-4234-8234-000000000000',
    taskIndex: 0,
  };

  it('TurnCompleteEvent accepts null cachedTokens and reasoningTokens', () => {
    const data = {
      ...baseTaskFields,
      event: 'turn_complete' as const,
      turnIndex: 1,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: null,
      reasoningTokens: null,
      costUSD: 0.01,
      durationMs: 1000,
      providerType: 'claude' as const,
      model: 'claude-sonnet-4-6',
    };
    const result = TurnCompleteEvent.safeParse(data);
    if (!result.success) {
      console.error('TurnCompleteEvent errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  it('TurnCompleteEvent rejects omitted cachedTokens and reasoningTokens (must be present per §3.6)', () => {
    const result = TurnCompleteEvent.safeParse({
      ...baseTaskFields,
      event: 'turn_complete',
      turnIndex: 1,
      inputTokens: 100,
      outputTokens: 50,
      costUSD: 0.01,
      durationMs: 1000,
      providerType: 'openai-compatible',
      model: 'gpt-5',
    });
    // Per §3.6 honest-null: fields must always be present (null = unexposed by provider; number = real value)
    expect(result.success).toBe(false);
  });

  it('TurnCompleteEvent accepts zero cachedTokens (real observed value)', () => {
    const result = TurnCompleteEvent.safeParse({
      ...baseTaskFields,
      event: 'turn_complete',
      turnIndex: 2,
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUSD: 0.02,
      durationMs: 2000,
      providerType: 'claude',
      model: 'claude-sonnet-4-6',
    });
    expect(result.success).toBe(true);
  });

  it('TaskCompletedLocalEvent accepts null cachedTokens and reasoningTokens', () => {
    const result = TaskCompletedLocalEvent.safeParse({
      ...baseTaskFields,
      event: 'task_completed',
      status: 'ok',
      workerStatus: 'done',
      turns: 5,
      durationMs: 30000,
      filesRead: 10,
      filesWritten: 3,
      toolCalls: 8,
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: null,
      reasoningTokens: null,
      costUSD: 0.05,
      taskMaxIdleMs: null,
      stallTriggered: false,
      stages: '{}',
    });
    expect(result.success).toBe(true);
  });

  it('TaskCompletedLocalEvent rejects omitted cachedTokens and reasoningTokens (must be present per §3.6)', () => {
    const result = TaskCompletedLocalEvent.safeParse({
      ...baseTaskFields,
      event: 'task_completed',
      status: 'ok',
      workerStatus: 'done',
      turns: 5,
      durationMs: 30000,
      filesRead: 10,
      filesWritten: 3,
      toolCalls: 8,
      inputTokens: 1000,
      outputTokens: 500,
      costUSD: 0.05,
      taskMaxIdleMs: null,
      stallTriggered: false,
      stages: '{}',
    });
    expect(result.success).toBe(false);
  });
});
