import { describe, it, expect } from 'vitest';
import { ResponseEnvelopeBuilder } from '../../packages/core/src/reporting/response-envelope-builder.js';

describe('ResponseEnvelopeBuilder', () => {
  const b = new ResponseEnvelopeBuilder();

  it('buildTask preserves required + nested cost', () => {
    const e = b.buildTask({
      taskId: 'task_a',
      tool: 'delegate_tasks',
      terminalStatus: 'ok',
      workerStatus: 'done',
      errorCode: null,
      headline: 'Did the thing',
      durationMs: 1200,
      cost: { actualUSD: 0.05, deltaUSD: 0.5, currency: 'USD' },
    });
    expect(e.tool).toBe('delegate_tasks');
    expect(e.cost?.actualUSD).toBe(0.05);
  });

  it('buildBatch sums actualUSD and deltaUSD across tasks', () => {
    const tasks = [
      {
        taskId: 't1', tool: 'delegate_tasks', terminalStatus: 'ok' as const,
        workerStatus: 'done' as const, errorCode: null, headline: 'a', durationMs: 100,
        cost: { actualUSD: 0.1, deltaUSD: 0.2, currency: 'USD' as const },
      },
      {
        taskId: 't2', tool: 'delegate_tasks', terminalStatus: 'ok' as const,
        workerStatus: 'done' as const, errorCode: null, headline: 'b', durationMs: 100,
        cost: { actualUSD: 0.3, deltaUSD: 0.5, currency: 'USD' as const },
      },
    ];
    const env = b.buildBatch('batch_x', tasks);
    expect(env.batchCost.actualUSD).toBeCloseTo(0.4);
    expect(env.batchCost.deltaUSD).toBeCloseTo(0.7);
    expect(env.batchCost.tasksCount).toBe(2);
  });

  it('buildBatch poisons deltaUSD to null when any task has null delta', () => {
    const tasks = [
      {
        taskId: 't1', tool: 'delegate_tasks', terminalStatus: 'ok' as const,
        workerStatus: 'done' as const, errorCode: null, headline: 'a', durationMs: 100,
        cost: { actualUSD: 0.1, deltaUSD: 0.2, currency: 'USD' as const },
      },
      {
        taskId: 't2', tool: 'delegate_tasks', terminalStatus: 'ok' as const,
        workerStatus: 'done' as const, errorCode: null, headline: 'b', durationMs: 100,
        cost: { actualUSD: 0.3, deltaUSD: null, currency: 'USD' as const },
      },
    ];
    const env = b.buildBatch('batch_x', tasks);
    expect(env.batchCost.deltaUSD).toBeNull();
    expect(env.batchCost.actualUSD).toBeCloseTo(0.4);
  });

  it('omits cost on tasks where model did not run (sync routes)', () => {
    const e = b.buildTask({
      taskId: 'task_sync', tool: 'register-context-block', terminalStatus: 'ok',
      workerStatus: 'done', errorCode: null, headline: 'block registered', durationMs: 5,
    });
    expect(e.cost).toBeUndefined();
  });

  it('includes concernCount only when review ran', () => {
    const e = b.buildTask({
      taskId: 't', tool: 'audit_document', terminalStatus: 'ok', workerStatus: 'done',
      errorCode: null, headline: 'h', durationMs: 100,
      concernCount: 3,
    });
    expect(e.concernCount).toBe(3);
  });
});
