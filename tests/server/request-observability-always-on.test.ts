import { describe, it, expect, vi } from 'vitest';
import { emitRequestReceived } from '../../packages/server/src/http/request-observability.js';

describe('emitRequestReceived — always-on (A4, A8)', () => {
  it('emits batch_created and request_received via bus', async () => {
    const busEmitCalls: unknown[] = [];
    const logWriterSpillCalls: unknown[] = [];

    const deps = {
      bus: {
        emitPlainEntry: vi.fn((entry) => { busEmitCalls.push(entry); }),
      },
      logWriter: {
        inlineBodyLimit: vi.fn(() => 16_384),
        spillRequestBody: vi.fn(async (input) => {
          logWriterSpillCalls.push(input);
          return { path: '/tmp/b-1.json', bytes: 1024 };
        }),
      },
    };

    await emitRequestReceived(deps as any, 'b-1', '/delegate', { hello: 'world' });

    // Should have called emitPlainEntry twice: batch_created and request_received
    expect(busEmitCalls).toHaveLength(2);

    const [batchCreatedCall, requestReceivedCall] = busEmitCalls;

    // Verify batch_created call
    expect((batchCreatedCall as any).kind).toBe('batch_created');
    expect((batchCreatedCall as any).fields.batch_id).toBe('b-1');
    expect((batchCreatedCall as any).fields.route).toBe('/delegate');

    // Verify request_received call
    expect((requestReceivedCall as any).kind).toBe('request_received');
    expect((requestReceivedCall as any).fields.batch_id).toBe('b-1');
    expect((requestReceivedCall as any).fields.route).toBe('/delegate');
    expect(typeof (requestReceivedCall as any).fields.body_bytes).toBe('number');
    expect((requestReceivedCall as any).fields.body).toBeDefined();
  });
});
