import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCreateContextBlockHandler } from '../../../packages/server/src/http/handlers/control/context-blocks.js';
import type { ProjectRegistry } from '../../../packages/server/src/http/project-registry.js';
import type { LifecycleDispatcher } from '@zhixuan92/multi-model-agent-core';

function mockReq(contentLength: number): IncomingMessage {
  return {
    headers: { 'content-length': String(contentLength) },
  } as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; body: () => unknown; status: () => number } {
  let _status = 200;
  let _body: unknown = null;
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      _status = status;
      return res;
    },
    end(chunk: string) {
      try {
        _body = JSON.parse(chunk);
      } catch {
        _body = chunk;
      }
      return res;
    },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => _body,
    status: () => _status,
  };
}

describe('register-context-block 413', () => {
  it('rejects payload > 524288 bytes with 413', async () => {
    const handler = buildCreateContextBlockHandler({
      projectRegistry: {} as ProjectRegistry,
      routeDispatcher: { dispatch: () => Promise.resolve({ status: 200, body: {} }) } as unknown as LifecycleDispatcher,
      maxContextBlockBytes: 524_288,
      maxContextBlocksPerProject: 32,
    });
    const { res, body, status } = mockRes();

    await handler(mockReq(100), res, {}, { cwd: '/tmp/test', body: { content: 'a'.repeat(524_289) } } as any);

    expect(status()).toBe(413);
    const b = body() as any;
    expect(b.error.code).toBe('payload_too_large');
  });

  it('allows payload under the byte limit', async () => {
    const handler = buildCreateContextBlockHandler({
      projectRegistry: {
        reserveProject: () => ({ ok: false, error: 'unavailable', message: 'stub' }),
      } as unknown as ProjectRegistry,
      routeDispatcher: { dispatch: () => Promise.resolve({ status: 200, body: {} }) } as unknown as LifecycleDispatcher,
      maxContextBlockBytes: 1024,
      maxContextBlocksPerProject: 32,
    });
    const { res, status } = mockRes();

    await handler(mockReq(100), res, {}, { cwd: '/tmp/test', body: { content: 'x' } } as any);

    // Should have passed the byte cap and hit the project reserve (503)
    expect(status()).not.toBe(413);
  });
});
