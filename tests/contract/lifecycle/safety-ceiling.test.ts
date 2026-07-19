import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  __liveByTask,
  SafetyCeilingExceededError,
  TaskSessionLimitExceededError,
  MissingTaskIdentityError,
} from '../../../packages/core/src/providers/provider-factory.js';
// wrapWithSafetyCeiling is the internal wrapper; if not exported, exercise
// it via createProvider() with a test override using
// __setCoreTestProviderOverride. The test override path applies the
// safety wrapper to the injected mock provider.
import {
  createProvider,
  __setCoreTestProviderOverride,
} from '../../../packages/core/src/providers/provider-factory.js';
import type { Provider, SessionOpts, Session } from '../../../packages/core/src/types/run-result.js';

type MockSession = Session & { closeFn: ReturnType<typeof vi.fn> };

function makeFakeSession(closeImpl: () => Promise<void> = async () => {}): MockSession {
  const closeFn = vi.fn(closeImpl);
  return {
    async send() { return { output: '', usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 }, costUSD: 0, turns: 0, durationMs: 0, terminationReason: 'ok', filesWritten: [], usedShell: false } as any; },
    close: closeFn,
    closeFn,
    getSessionId() { return null; },
  } as MockSession;
}

function mockProvider(behavior: (opts: SessionOpts) => Session): Provider {
  return {
    name: 'standard',
    config: { type: 'codex', model: 'm' } as any,
    openSession: vi.fn((opts: SessionOpts) => behavior(opts)),
  };
}

function opts(taskId: string | undefined, taskIndex: number | undefined): SessionOpts {
  return {
    cwd: '/tmp',
    wallClockDeadline: Date.now() + 60_000,
    abortSignal: new AbortController().signal,
    ...(taskId !== undefined && { taskId }),
    ...(taskIndex !== undefined && { taskIndex }),
  } as SessionOpts;
}

describe('provider-factory per-task safety (D6)', () => {
  beforeEach(() => {
    process.env.MMA_TEST_PROVIDER_OVERRIDE = '1';
  });

  it('A6.1 — TaskSessionLimitExceeded after 2 opens for same key; 2-and-2 across keys succeed', () => {
    __setCoreTestProviderOverride(mockProvider(() => makeFakeSession()));
    const cfg = { agents: { standard: { type: 'codex', model: 'm' } } } as any;
    const p = createProvider('standard', cfg);
    const s1 = p.openSession(opts('B', 0));
    const s2 = p.openSession(opts('B', 0));
    expect(() => p.openSession(opts('B', 0))).toThrow(TaskSessionLimitExceededError);
    // Across distinct keys: 2 + 2 succeed
    const s3 = p.openSession(opts('B', 1));
    const s4 = p.openSession(opts('B', 1));
    expect(__liveByTask().get('B:0')?.size).toBe(2);
    expect(__liveByTask().get('B:1')?.size).toBe(2);
    // cleanup
    return Promise.all([s1.close(), s2.close(), s3.close(), s4.close()]);
  });

  it('A6.2 — MissingTaskIdentityError thrown BEFORE underlying open is invoked', () => {
    const inner = vi.fn(() => makeFakeSession());
    __setCoreTestProviderOverride(mockProvider(inner));
    const cfg = { agents: { standard: { type: 'codex', model: 'm' } } } as any;
    const p = createProvider('standard', cfg);
    expect(() => p.openSession(opts(undefined, 0))).toThrow(MissingTaskIdentityError);
    expect(() => p.openSession(opts('B', undefined))).toThrow(MissingTaskIdentityError);
    expect(inner).not.toHaveBeenCalled();
  });

  it('A6.3 — synchronous throw from inner openSession does not leak the per-task counter', () => {
    const before = __liveByTask().get('B:9')?.size ?? 0;
    __setCoreTestProviderOverride(mockProvider(() => { throw new Error('spawn_failed'); }));
    const cfg = { agents: { standard: { type: 'codex', model: 'm' } } } as any;
    const p = createProvider('standard', cfg);
    expect(() => p.openSession(opts('B', 9))).toThrow('spawn_failed');
    expect(__liveByTask().get('B:9')?.size ?? 0).toBe(before); // no leak
  });

  it('A6.5 — 101st live session across all keys throws SafetyCeilingExceeded', () => {
    __setCoreTestProviderOverride(mockProvider(() => makeFakeSession()));
    const cfg = { agents: { standard: { type: 'codex', model: 'm' } } } as any;
    const p = createProvider('standard', cfg);
    const sessions: Session[] = [];
    // open 2 sessions × 50 keys = 100 live children
    for (let k = 0; k < 50; k++) {
      sessions.push(p.openSession(opts('B', k)));
      sessions.push(p.openSession(opts('B', k)));
    }
    // 101st (any new key, since existing keys are full) → SafetyCeilingExceeded
    expect(() => p.openSession(opts('B', 50))).toThrow(SafetyCeilingExceededError);
    return Promise.all(sessions.map((s) => s.close()));
  });

});
