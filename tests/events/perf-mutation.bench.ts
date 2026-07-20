// tests/events/perf-mutation.bench.ts
import { bench } from 'vitest';
import { TaskEnvelopeStore } from '../fixtures/task-envelope-store.js';

const seed = { taskId: 't', batchId: 'b', taskIndex: 0, route: 'delegate' as const, agentType: 'standard' as const, client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: '/tmp', reviewPolicy: 'reviewed' as const };

bench('small envelope (3 stages, 0 tool calls)', () => {
  const s = TaskEnvelopeStore.create(seed);
  for (const name of ['implementing','reviewing','annotating'] as const) {
    s.startStage(name, { model: 'claude-sonnet-4-6', tier: 'standard' });
    s.completeStage(name, 1, { outcome: 'advance', durationMs: 1000, inputTokens: 100, outputTokens: 50 });
  }
}, { time: 1000 });

bench('medium envelope (5 stages, 50 tool calls)', () => {
  const s = TaskEnvelopeStore.create(seed);
  for (const name of ['implementing','reviewing','reworking','annotating','committing'] as const) {
    s.startStage(name, { model: 'claude-sonnet-4-6', tier: 'standard' });
    for (let i = 0; i < 10; i++) s.recordToolCall({ stage: name, tool: 'Read', filesRead: [`/f${i}`] });
    s.completeStage(name, 1, { outcome: 'advance', durationMs: 1000, inputTokens: 100, outputTokens: 50 });
  }
}, { time: 1000 });

bench('large envelope (5 stages, 500 tool calls)', () => {
  const s = TaskEnvelopeStore.create(seed);
  for (const name of ['implementing','reviewing','reworking','annotating','committing'] as const) {
    s.startStage(name, { model: 'claude-sonnet-4-6', tier: 'standard' });
    for (let i = 0; i < 100; i++) s.recordToolCall({ stage: name, tool: 'Read', filesRead: [`/f${i}`] });
    s.completeStage(name, 1, { outcome: 'advance', durationMs: 1000, inputTokens: 100, outputTokens: 50 });
  }
}, { time: 2000 });
