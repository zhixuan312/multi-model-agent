import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCreateContextBlockHandler } from '../../../packages/server/src/http/handlers/control/context-blocks.js';
import type { ProjectRegistry } from '../../../packages/server/src/http/project-registry.js';
import type { ServerConfig } from '@zhixuan92/multi-model-agent-core';

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
  it('rejects payload > 50 MiB with 413', async () => {
    const handler = buildCreateContextBlockHandler({
      projectRegistry: {} as ProjectRegistry,
      config: { server: { limits: { maxContextBlockBytes: 524_288, maxContextBlocksPerProject: 32 } } } as ServerConfig,
    });
    const req = mockReq(51 * 1024 * 1024);
    const { res, body, status } = mockRes();

    await handler(req, res, {}, { cwd: '/tmp/test', body: undefined } as any);

    expect(status()).toBe(413);
    const b = body() as any;
    expect(b.error.code).toBe('request_entity_too_large');
  });

  it('allows payload well under 50 MiB', async () => {
    const handler = buildCreateContextBlockHandler({
      projectRegistry: {
        reserveProject: () => ({ ok: false, error: 'unavailable', message: 'stub' }),
      } as unknown as ProjectRegistry,
      config: { server: { limits: { maxContextBlockBytes: 50 * 1024 * 1024, maxContextBlocksPerProject: 32 } } } as ServerConfig,
    });
    // content-length under 50 MiB — should pass the pre-body cap and move to body validation
    const req = mockReq(100);
    const { res, status } = mockRes();

    await handler(req, res, {}, { cwd: '/tmp/test', body: { content: 'x' } } as any);

    // Should have passed the 50 MiB cap and hit the body validation (400) or project reserve (503)
    // Either way, NOT 413
    expect(status()).not.toBe(413);
  });
});
