import { describe, it, expect } from 'vitest';
import { registerToBlockStoreHandler } from '../../../packages/core/src/lifecycle/handlers/register-context-block-handlers.js';
import { mockState } from '../../fixtures/lifecycle-state.js';
import type { LifecycleState } from '../../../packages/core/src/lifecycle/stage-plan-types.js';

function mkRegisterState(body: string): LifecycleState {
  return mockState({ route: 'register-context-block', request: { content: body } as any });
}

describe('registerToBlockStoreHandler', () => {
  it('returns advance with blockId + bytes on success', async () => {
    const state = mkRegisterState('hello');
    const gate = await registerToBlockStoreHandler(state);
    expect(gate.outcome).toBe('advance');
    expect((gate.payload as any).blockId).toMatch(/^cb-/);
    expect((gate.payload as any).bytes).toBe(5);
  });

  it('halts on body too large', async () => {
    const state = mkRegisterState('a'.repeat(60 * 1024 * 1024));
    const gate = await registerToBlockStoreHandler(state);
    expect(gate.outcome).toBe('halt');
    expect(gate.comment).toMatch(/payload_too_large/);
  });
});