import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/telemetry/event-builder.js';

describe('recorder context threading', () => {
  it('preserves reviewPolicy and verifyCommandPresent from BuildContext', () => {
    const ctx: any = {
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: { status: 'ok', terminationReason: { cause: 'finished' }, durationMs: 100 } as any,
      client: 'claude-code',
      triggeringSkill: 'mma-delegate',
      parentModel: 'claude-sonnet-4-6',
      reviewPolicy: 'diff_only',
      verifyCommandPresent: true,
    };
    const ev = buildTaskCompletedEvent(ctx);
    expect(ev.reviewPolicy).toBe('diff_only');
    expect(ev.verifyCommandPresent).toBe(true);
  });

  it('reviewPolicy=none preserves reviewPolicy=none wire value', () => {
    const ctx: any = {
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: { status: 'ok', terminationReason: { cause: 'finished' }, durationMs: 100 } as any,
      client: 'claude-code', triggeringSkill: 'mma-delegate', parentModel: null,
      reviewPolicy: 'none', verifyCommandPresent: false,
    };
    const ev = buildTaskCompletedEvent(ctx);
    expect(ev.reviewPolicy).toBe('none');
  });
});
