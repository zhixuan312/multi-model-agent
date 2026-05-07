import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { bootstrapWithMockAdapterAndOverrides } from '../helpers/bootstrap.js';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

function makeRegisterComposeResponse(store: InMemoryContextBlockStore): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as { content?: string } | undefined;
    if (!req || typeof req.content !== 'string' || req.content.length === 0) {
      (state as any).responseEnvelope = { error: 'missing_content' };
      return;
    }
    const registered = store.register(req.content);
    (state as any).responseEnvelope = { id: registered.id };
  };
}

describe('register-context-block via v4.0 lifecycle', () => {
  it('creates a block through the StagePlan without bypass', async () => {
    const store = new InMemoryContextBlockStore();
    const adapter = mockAdapter({ turns: [] });

    const result = await bootstrapWithMockAdapterAndOverrides(
      adapter,
      {
        compose_response: makeRegisterComposeResponse(store),
      },
      { store },
    ).dispatch({
      route: 'register-context-block',
      toolCategory: 'assist',
      rawRequest: { content: 'hello world' },
    });

    expect(result.status).toBe(200);
    const body: any = result.body;
    expect(body).toHaveProperty('id');
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);

    // Verify the block is actually stored and retrievable
    const stored = store.get(body.id);
    expect(stored).toBe('hello world');
  });

  it('returns error envelope when content is missing', async () => {
    const store = new InMemoryContextBlockStore();
    const adapter = mockAdapter({ turns: [] });

    const result = await bootstrapWithMockAdapterAndOverrides(
      adapter,
      {
        compose_response: makeRegisterComposeResponse(store),
      },
      { store },
    ).dispatch({
      route: 'register-context-block',
      toolCategory: 'assist',
      rawRequest: { content: '' },
    });

    expect(result.status).toBe(200);
    expect((result.body as any)?.error).toBe('missing_content');
  });
});
