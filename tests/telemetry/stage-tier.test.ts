import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';

describe('Task 21: stage tier and implementerTier', () => {
  it('every stage entry has a tier field; top-level has implementerTier', () => {
    const ctx: any = {
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: {
        status: 'ok',
        terminationReason: { cause: 'finished' },
        durationMs: 100,
        usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.001 },
        stageStats: {
          implementing: { entered: true, durationMs: 50, costUSD: 0.001, agentTier: 'standard', model: 'mock-std' },
        },
      } as any,
      client: 'claude-code',
      triggeringSkill: 'mma-delegate',
      mainModel: null,
      reviewPolicy: 'none',
      verifyCommandPresent: false,
    };
    const ev = buildTaskCompletedEvent(ctx);
    expect(ev.implementerTier).toBe('standard');
    for (const s of ev.stages) {
      expect(s.tier).toBeDefined();
      expect(['standard', 'complex']).toContain(s.tier);
    }
  });

  it('propagates complex tier from implementing stage to implementerTier', () => {
    const ctx: any = {
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: {
        status: 'ok',
        terminationReason: { cause: 'finished' },
        durationMs: 100,
        usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.001 },
        stageStats: {
          implementing: { entered: true, durationMs: 50, costUSD: 0.001, agentTier: 'complex', model: 'mock-complex' },
        },
      } as any,
      client: 'claude-code',
      triggeringSkill: 'mma-delegate',
      mainModel: null,
      reviewPolicy: 'none',
      verifyCommandPresent: false,
    };
    const ev = buildTaskCompletedEvent(ctx);
    expect(ev.implementerTier).toBe('complex');
    for (const s of ev.stages) {
      expect(s.tier).toBe('complex');
    }
  });
});
