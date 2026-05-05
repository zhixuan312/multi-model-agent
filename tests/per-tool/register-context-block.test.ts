import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RouteDispatcher, InMemoryContextBlockStore } from '../../packages/core/src/index.js';
import type { ContextBlockStore, ContextBlockHandler } from '../../packages/core/src/index.js';

const MAX_BODY_BYTES = 50 * 1024 * 1024;

const createBlockSchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});

function createContextBlockHandler(store: ContextBlockStore): ContextBlockHandler {
  return async (rawRequest: unknown) => {
    const parsed = createBlockSchema.safeParse(rawRequest);
    if (!parsed.success) {
      return { status: 400, body: { error: 'invalid_request', details: parsed.error.flatten() } };
    }

    const { id, content } = parsed.data;

    const byteLen = Buffer.byteLength(content, 'utf8');
    if (byteLen > MAX_BODY_BYTES) {
      return {
        status: 413,
        body: { error: 'payload_too_large', message: `Content exceeds ${MAX_BODY_BYTES} bytes (got ${byteLen} bytes)` },
      };
    }

    const registered = store.register(content, id ? { id } : undefined);
    return { status: 200, body: { blockId: registered.id } };
  };
}

function bootstrapWithDirectHandler(store: ContextBlockStore): RouteDispatcher {
  return new RouteDispatcher({}, undefined, createContextBlockHandler(store));
}

describe('register_context_block via v4.0', () => {
  it('puts a block and returns blockId', async () => {
    const store = new InMemoryContextBlockStore();
    const dispatcher = bootstrapWithDirectHandler(store);

    const result = await dispatcher.dispatch({
      route: 'register-context-block',
      toolCategory: 'artifact_producing',
      rawRequest: { id: 'a', content: 'hello' },
    });

    expect(result.status).toBe(200);
    expect((result.body as any).blockId).toBe('a');
    expect(store.get('a')).toBe('hello');
  });

  it('auto-generates blockId when id is not provided', async () => {
    const store = new InMemoryContextBlockStore();
    const dispatcher = bootstrapWithDirectHandler(store);

    const result = await dispatcher.dispatch({
      route: 'register-context-block',
      toolCategory: 'artifact_producing',
      rawRequest: { content: 'world' },
    });

    expect(result.status).toBe(200);
    expect((result.body as any).blockId).toBeDefined();
    const blockId = (result.body as any).blockId as string;
    expect(store.get(blockId)).toBe('world');
  });

  it('rejects payload > 50 MiB with 413', async () => {
    const store = new InMemoryContextBlockStore();
    const dispatcher = bootstrapWithDirectHandler(store);

    const big = 'x'.repeat(51 * 1024 * 1024);
    const result = await dispatcher.dispatch({
      route: 'register-context-block',
      toolCategory: 'artifact_producing',
      rawRequest: { id: 'a', content: big },
    });

    expect(result.status).toBe(413);
  });

  it('rejects empty content with 400', async () => {
    const store = new InMemoryContextBlockStore();
    const dispatcher = bootstrapWithDirectHandler(store);

    const result = await dispatcher.dispatch({
      route: 'register-context-block',
      toolCategory: 'artifact_producing',
      rawRequest: { content: '' },
    });

    expect(result.status).toBe(400);
  });

  it('rejects missing content with 400', async () => {
    const store = new InMemoryContextBlockStore();
    const dispatcher = bootstrapWithDirectHandler(store);

    const result = await dispatcher.dispatch({
      route: 'register-context-block',
      toolCategory: 'artifact_producing',
      rawRequest: {},
    });

    expect(result.status).toBe(400);
  });
});
