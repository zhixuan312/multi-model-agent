import { describe, it, expect } from 'vitest';
import {
  __liveChildren,
  __safetyCeiling,
  SafetyCeilingExceededError,
  createProvider,
} from '../../../packages/core/src/providers/provider-factory.js';
import type { Provider, Session, SessionOpts, MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

// Provider that returns a session whose close() decrements normally — but
// send() never resolves, so we control liveChildren explicitly by closing.
function makeHoldProvider(): Provider {
  return {
    name: 'hold-mock',
    config: { type: 'codex', model: 'mock', baseUrl: 'http://mock', apiKey: 'k' } as never,
    openSession(_opts: SessionOpts): Session {
      return {
        async send() {
          return new Promise(() => { /* never resolves */ });
        },
        async close() { /* counter decrement is in factory wrapper */ },
      };
    },
  };
}

describe('safety ceiling — refuse beyond 100 children', () => {
  it('opens up to the ceiling, refuses with safety_ceiling_exceeded after', async () => {
    process.env.MMAGENT_TEST_PROVIDER_OVERRIDE = '1';
    const provider = makeHoldProvider();
    const config = { agents: { standard: { type: 'codex', model: 'm', baseUrl: 'http://x', apiKey: 'k' }, complex: { type: 'codex', model: 'm', baseUrl: 'http://x', apiKey: 'k' } } } as unknown as MultiModelConfig;
    const { __setCoreTestProviderOverride } = await import('../../../packages/core/src/providers/provider-factory.js');
    __setCoreTestProviderOverride(provider);

    const ceiling = __safetyCeiling();
    const startLive = __liveChildren();
    const opened: Session[] = [];
    const ctrl = new AbortController();
    const baseOpts: SessionOpts = {
      cwd: '/tmp',
      wallClockDeadline: Date.now() + 60_000,
      idleStallTimeoutMs: 30_000,
      abortSignal: ctrl.signal,
    };

    try {
      const factory = createProvider('standard', config);
      // Open exactly (ceiling - startLive) sessions; assert next throws.
      const slots = ceiling - startLive;
      for (let i = 0; i < slots; i++) {
        opened.push(factory.openSession(baseOpts));
      }
      expect(__liveChildren()).toBe(ceiling);
      let thrown: unknown;
      try { factory.openSession(baseOpts); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(SafetyCeilingExceededError);
      expect((thrown as { code: string }).code).toBe('safety_ceiling_exceeded');
    } finally {
      for (const s of opened) await s.close().catch(() => undefined);
      __setCoreTestProviderOverride(null);
    }
  });
});
