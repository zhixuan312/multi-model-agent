import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildCreateContextBlockHandler, contextBlockErrorToHttp } from '../../../packages/server/src/http/handlers/control/context-blocks.js';
import type { ProjectRegistry } from '../../../packages/server/src/application/project-registry.js';

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
      maxContextBlockBytes: 524_288,
      maxContextBlocksPerProject: 32,
    });
    const { res, body, status } = mockRes();

    await handler(mockReq(100), res, {}, { cwd: '/tmp/test', body: { content: 'a'.repeat(524_289) } } as any);

    expect(status()).toBe(413);
    const b = body() as any;
    expect(b.error.code).toBe('payload_too_large');
  });

  /**
   * The comment here used to say "should have passed the byte cap and hit the project reserve
   * (503)" while asserting only `not.toBe(413)` — and the stub returned `error: 'unavailable'`,
   * which is not a ReserveError, behind an `as unknown as` cast. So the handler mapped an unknown
   * code, `contextBlockErrorToHttp` fell through its exhaustive `default` and RETURNED THE CODE
   * STRING, and `writeHead('unavailable')` satisfied `not.toBe(413)`. The test passed on a response
   * that had no status at all.
   *
   * Now it uses a real ReserveError and asserts the status the comment always claimed.
   */
  it('passes the byte cap and surfaces the project-reserve failure as 503', async () => {
    const handler = buildCreateContextBlockHandler({
      projectRegistry: {
        reserveProject: () => ({ ok: false, error: 'project_cap', message: 'stub' }),
      } as unknown as ProjectRegistry,
      maxContextBlockBytes: 1024,
      maxContextBlocksPerProject: 32,
    });
    const { res, body, status } = mockRes();

    await handler(mockReq(100), res, {}, { cwd: '/tmp/test', body: { content: 'x' } } as any);

    expect(status()).toBe(503);
    expect((body() as { error: { code: string } }).error.code).toBe('project_cap');
  });

  /**
   * And the fallback itself: a code outside the union — reachable only through a cast, which is
   * exactly how it was reached — must still produce a NUMBER, not the code echoed back as a status.
   */
  it('maps an out-of-union error code to 500 rather than returning the code', () => {
    const status = contextBlockErrorToHttp('not-a-real-code' as never);
    expect(typeof status).toBe('number');
    expect(status).toBe(500);
  });
});
