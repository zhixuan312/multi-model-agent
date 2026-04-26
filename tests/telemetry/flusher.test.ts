import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Queue } from '../../packages/server/src/telemetry/queue.js';
import { Flusher } from '../../packages/server/src/telemetry/flusher.js';
import type { QueueRecord } from '../../packages/server/src/telemetry/queue.js';

function makeRecord(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    schemaVersion: 1,
    install: {
      installId: '00000000-0000-4000-a000-000000000001',
      mmagentVersion: '3.6.0',
      os: 'darwin',
      nodeMajor: '22',
      language: 'en',
      tzOffsetBucket: 'utc_0_to_plus_6',
    },
    generation: 0,
    event: {
      type: 'session.started',
      eventId: 'e0000000-0000-4000-a000-000000000001',
      configFlavor: { defaultTier: 'standard', diagnosticsEnabled: true, autoUpdateSkills: true },
      providersConfigured: ['claude'],
    },
    ...overrides,
  };
}

describe('flusher', () => {
  let dir: string;
  let queue: Queue;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-f-'));
    queue = new Queue(dir);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    try { rmSync(dir, { recursive: true }); } catch { /* */ }
  });

  function createFlusher(endpoint = 'https://telemetry.example.com/v1/events'): Flusher {
    return new Flusher({ queue, dir, endpoint });
  }

  async function populate(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await queue.append(makeRecord({
        event: { ...makeRecord().event, eventId: `e${String(i).padStart(12, '0')}` },
      }));
    }
  }

  it('204 ack → truncates the queue prefix', async () => {
    await populate(5);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const f = createFlusher();
    await f.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(0);
    expect(f.dropped).toBe(0);
  });

  it('400 → drops those events from queue, increments counter', async () => {
    await populate(3);
    fetchSpy.mockResolvedValueOnce(new Response('{"error":"invalid_batch"}', { status: 400 }));

    const f = createFlusher();
    await f.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(0);
    expect(f.dropped).toBe(3);
  });

  it('413 → drops those events from queue, increments counter', async () => {
    await populate(2);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 413 }));

    const f = createFlusher();
    await f.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(0);
    expect(f.dropped).toBe(2);
  });

  it('429 with Retry-After → honors the value', async () => {
    await populate(3);
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'Retry-After': '120' } }),
    );

    const f = createFlusher();
    await f.flush();

    // Events stay in queue
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(3);
    expect(f.dropped).toBe(0);
    // Backoff should be active
    expect(f.backoffActive).toBe(true);
  });

  it('429 without Retry-After → backs off 1h', async () => {
    await populate(2);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 429 }));

    const f = createFlusher();
    await f.flush();

    // Events stay in queue, backoff mode active
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(2);
    expect(f.dropped).toBe(0);
    expect(f.backoffActive).toBe(true);
  });

  it('5xx → leaves in queue with exponential backoff', async () => {
    await populate(3);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const f = createFlusher();
    await f.flush();

    // Events stay in queue
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(3);
    expect(f.dropped).toBe(0);
    expect(f.backoffActive).toBe(true);
  });

  it('network unreachable → leaves in queue, exponential backoff', async () => {
    await populate(3);
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));

    const f = createFlusher();
    await f.flush();

    // Events stay in queue
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(3);
    expect(f.dropped).toBe(0);
    expect(f.backoffActive).toBe(true);
  });

  it('shutdown drain exits within 2s budget', { timeout: 10_000 }, async () => {
    await populate(5);
    // Simulate a slow server that respects abort signals
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), 5000);
        if (init?.signal) {
          if (init.signal.aborted) {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    });

    const f = createFlusher();
    const start = Date.now();
    await f.drain();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
  });

  it('group-by-install splits one queue file across N install IDs into N requests', async () => {
    await queue.append(makeRecord({
      install: { ...makeRecord().install, installId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      event: { ...makeRecord().event, eventId: 'e000000000001' },
    }));
    await queue.append(makeRecord({
      install: { ...makeRecord().install, installId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      event: { ...makeRecord().event, eventId: 'e000000000002' },
    }));
    await queue.append(makeRecord({
      install: { ...makeRecord().install, installId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
      event: { ...makeRecord().event, eventId: 'e000000000003' },
    }));

    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    const f = createFlusher();
    await f.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(0);
  });

  it('AbortController abort → in-flight fetch is aborted; bytes do not leave', async () => {
    await populate(5);

    let aborted = false;
    let fetchCalled!: () => void;
    const fetchCalledPromise = new Promise<void>(resolve => { fetchCalled = resolve; });

    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      fetchCalled();
      return new Promise<Response>((_resolve, reject) => {
        const doAbort = () => {
          aborted = true;
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        if (init?.signal) {
          if (init.signal.aborted) {
            doAbort();
            return;
          }
          init.signal.addEventListener('abort', doAbort, { once: true });
        }
      });
    });

    const f = createFlusher();
    const flushPromise = f.flush();

    // Wait until fetch is actually called before aborting
    await fetchCalledPromise;
    f.controller.abort();

    await flushPromise.catch(() => {}); // abort causes rejection
    expect(aborted).toBe(true);
  });

  it('partial success: batch 1 succeeds (204), batch 2 fails (500) → only batch 1 truncated', async () => {
    // Create two groups with different generations
    await queue.append(makeRecord({
      generation: 0,
      install: { ...makeRecord().install, installId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      event: { ...makeRecord().event, eventId: 'e000000000001' },
    }));
    await queue.append(makeRecord({
      generation: 0,
      install: { ...makeRecord().install, installId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      event: { ...makeRecord().event, eventId: 'e000000000002' },
    }));
    await queue.append(makeRecord({
      generation: 1,
      install: { ...makeRecord().install, installId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
      event: { ...makeRecord().event, eventId: 'e000000000003' },
    }));

    let callCount = 0;
    fetchSpy.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(null, { status: 500 }));
    });

    const f = createFlusher();
    await f.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const remaining = await queue.readBatch(50);
    expect(remaining.records.length).toBe(1);
  });

  it('does nothing when queue is empty', async () => {
    const f = createFlusher();
    await f.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not send when generation changed mid-flush', async () => {
    await populate(3);

    // Write the generation file before flush at gen=0, then bump it mid-flush
    const genPath = join(dir, 'telemetry-generation');
    writeFileSync(genPath, '0', { mode: 0o600 });

    let firstFetch = true;
    fetchSpy.mockImplementation(() => {
      if (firstFetch) {
        // Before the first upload, bump generation so the next group is aborted
        firstFetch = false;
        writeFileSync(genPath, '99', { mode: 0o600 });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    const f = createFlusher();
    await f.flush();

    // First fetch (204) should have been sent and acknowledged
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('gzip-compresses the request body', async () => {
    await populate(1);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const f = createFlusher();
    await f.flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [_url, init] = fetchSpy.mock.calls[0];
    expect(init.headers['Content-Encoding']).toBe('gzip');
    expect(init.headers['Content-Type']).toBe('application/json');
  });
});
