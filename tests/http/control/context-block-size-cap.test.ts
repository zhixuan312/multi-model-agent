import { describe, it, expect } from 'bun:test';
import { buildCreateContextBlockHandler } from '../../../packages/server/src/http/handlers/control/context-blocks.js';
import type { ProjectRegistry } from '../../../packages/server/src/http/project-registry.js';

describe('register-context-block 413', () => {
  it('rejects payload > 524288 bytes with 413', async () => {
    const handler = buildCreateContextBlockHandler({
      projectRegistry: {} as ProjectRegistry,
      maxContextBlockBytes: 524_288,
      maxContextBlocksPerProject: 32,
    });

    const res = await handler({}, { cwd: '/tmp/test', body: { content: 'a'.repeat(524_289) } } as never);

    expect(res.status).toBe(413);
    const b = await res.json() as { error: { code: string } };
    expect(b.error.code).toBe('payload_too_large');
  });

  it('allows payload under the byte limit', async () => {
    const handler = buildCreateContextBlockHandler({
      projectRegistry: {
        reserveProject: () => ({ ok: false, error: 'unavailable', message: 'stub' }),
      } as unknown as ProjectRegistry,
      maxContextBlockBytes: 1024,
      maxContextBlocksPerProject: 32,
    });

    const res = await handler({}, { cwd: '/tmp/test', body: { content: 'x' } } as never);

    // Should have passed the byte cap and hit the project reserve (503)
    expect(res.status).not.toBe(413);
  });
});
