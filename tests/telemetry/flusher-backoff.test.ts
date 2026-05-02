import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Queue } from '../../packages/server/src/telemetry/queue.js';
import { Flusher } from '../../packages/server/src/telemetry/flusher.js';
import { getOrCreateIdentity } from '../../packages/server/src/telemetry/identity.js';
import type { QueueRecord, RecordMeta, ReadBatchResult } from '../../packages/server/src/telemetry/queue.js';

const INITIAL_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

function makeRecord(overrides: Partial<QueueRecord> & { installId: string }): QueueRecord {
  return {
    schemaVersion: 3,
    mmagentVersion: '3.11.1',
    os: 'darwin',
    nodeMajor: 22,
    generation: 0,
    events: [{ eventId: `ev-${Date.now()}-${Math.random().toString(36).slice(2)}`, eventType: 'task.completed', occurredAt: new Date().toISOString() }],
    ...overrides,
  };
}

function restoreFetch(original: typeof globalThis.fetch): void {
  (globalThis as any).fetch = original;
}

// ---------------------------------------------------------------------------
// In-memory Queue mock — avoids real filesystem I/O so fake timers work.
// ---------------------------------------------------------------------------
function createMockQueue(): { records: QueueRecord[]; queue: Queue } {
  const records: QueueRecord[] = [];
  const queue = {
    get queuePath() { return '/mock/queue'; },
    append: async (r: QueueRecord) => { records.push(r); },
    readBatch: async (maxRecords = 500): Promise<ReadBatchResult> => {
      const slice = records.slice(0, maxRecords);
      const meta: RecordMeta[] = slice.map((_, i) => ({
        byteOffset: i * 100,
        byteLength: 99,
        sha256: `sha256-${i}`,
      }));
      return { records: slice, meta };
    },
    truncate: async (expectedMeta: RecordMeta[]) => {
      records.splice(0, expectedMeta.length);
    },
  } as unknown as Queue;
  return { records, queue };
}

// ---------------------------------------------------------------------------
// Tests 1-3: head-truncation (identity mismatch + legacy schema)
//   Uses real Queue — these don't need fake timers.
// ---------------------------------------------------------------------------
describe('flusher head-truncation', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-flush-head-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // Test 1 — identity-mismatch records dropped at head (Edit A)
  it('drops identity-mismatch records at head and delivers matching records (Test 1)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      const currentInstallId = identity.installId;
      const staleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const queue = new Queue(dir);

      for (let i = 0; i < 3; i++) {
        await queue.append(makeRecord({ installId: staleId }));
      }
      for (let i = 0; i < 2; i++) {
        await queue.append(makeRecord({ installId: currentInstallId }));
      }

      const calls: { body: Buffer }[] = [];
      (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
        calls.push({ body: init.body as Buffer });
        return new Response(null, { status: 204 });
      };

      const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
      await flusher.flush();

      expect(calls).toHaveLength(1);
      const sentJson = JSON.parse(gunzipSync(calls[0].body).toString('utf8'));
      expect(sentJson.installId).toBe(currentInstallId);
      expect(sentJson.events).toHaveLength(2);

      expect(flusher.dropped).toBe(3);

      const remaining = await queue.readBatch(50);
      expect(remaining.records).toHaveLength(0);
    } finally {
      restoreFetch(originalFetch);
    }
  });

  // Test 2 primary — interleaved stale records: only contiguous prefix dropped
  it('drops only contiguous stale prefix, trailing stale stays for next flush (Test 2 primary)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      const currentInstallId = identity.installId;
      const staleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const queue = new Queue(dir);

      await queue.append(makeRecord({ installId: staleId }));
      await queue.append(makeRecord({ installId: currentInstallId }));
      await queue.append(makeRecord({ installId: staleId }));

      const calls: { at: number; status: number; installId: string }[] = [];
      (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
        const status = body.installId === currentInstallId ? 204 : 401;
        calls.push({ at: Date.now(), status, installId: body.installId });
        return new Response(null, { status });
      };

      const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
      await flusher.flush();

      // 2 fetch calls: current (204), trailing stale (401 → 5xx)
      expect(calls).toHaveLength(2);
      expect(calls[0].installId).toBe(currentInstallId);
      expect(calls[0].status).toBe(204);
      expect(calls[1].installId).toBe(staleId);
      expect(calls[1].status).toBe(401);
      expect(flusher.dropped).toBe(1);
      expect(flusher.backoffActive).toBe(true);

      let batch = await queue.readBatch(50);
      expect(batch.records).toHaveLength(1);
      expect(batch.records[0].installId).toBe(staleId);

      flusher.clearBackoff();

      // Flush 2: trailing stale now at head → dropped locally → clearBackoff
      await flusher.flush();

      expect(calls).toHaveLength(2); // no new fetch calls
      expect(flusher.dropped).toBe(2);
      expect(flusher.backoffActive).toBe(false);

      batch = await queue.readBatch(50);
      expect(batch.records).toHaveLength(0);
    } finally {
      restoreFetch(originalFetch);
    }
  });

  // Test 2 secondary — 400 variant (backend-aligned)
  it('drops stale prefix and 400-drops trailing stale in one flush (Test 2 secondary)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      const currentInstallId = identity.installId;
      const staleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const queue = new Queue(dir);

      await queue.append(makeRecord({ installId: staleId }));
      await queue.append(makeRecord({ installId: currentInstallId }));
      await queue.append(makeRecord({ installId: staleId }));

      const calls: { at: number; status: number }[] = [];
      (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
        const status = body.installId === currentInstallId ? 204 : 400;
        calls.push({ at: Date.now(), status });
        return new Response(null, { status });
      };

      const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
      await flusher.flush();

      expect(calls).toHaveLength(2);
      expect(calls[0].status).toBe(204);
      expect(calls[1].status).toBe(400);

      const batch = await queue.readBatch(50);
      expect(batch.records).toHaveLength(0);
      expect(flusher.backoffActive).toBe(false);
      expect(flusher.dropped).toBe(2);
    } finally {
      restoreFetch(originalFetch);
    }
  });

  // Test 3 — existing 3.10.7 legacy-head case still works + backoff stays inactive
  it('drops legacy-schema head records and backoff stays inactive (Test 3)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      const queue = new Queue(dir);

      await (queue.append as any)({ schemaVersion: 1, install: { installId: identity.installId, mmagentVersion: '0.2.0', os: 'linux', nodeMajor: '22' }, generation: 0, event: { eventId: 'aa11aa11-aa11-4a11-8a11-aa11aa11aa11' } });
      await (queue.append as any)({ schemaVersion: 2, install: { installId: identity.installId, mmagentVersion: '1.0.0', os: 'linux', nodeMajor: '22' }, generation: 0, events: [{ eventId: 'bb22bb22-bb22-4b22-8b22-bb22bb22bb22' }] });
      await queue.append(makeRecord({ installId: identity.installId }));

      const calls: { body: Buffer }[] = [];
      (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
        calls.push({ body: init.body as Buffer });
        return new Response(null, { status: 204 });
      };

      const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
      await flusher.flush();

      expect(calls).toHaveLength(1);
      const sentJson = JSON.parse(gunzipSync(calls[0].body).toString('utf8'));
      expect(sentJson.schemaVersion).toBe(3);
      expect(sentJson.events).toHaveLength(1);

      const remaining = await queue.readBatch(50);
      expect(remaining.records).toHaveLength(0);

      expect(flusher.backoffActive).toBe(false);
      expect(flusher.dropped).toBe(2);
    } finally {
      restoreFetch(originalFetch);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests 4-7: backoff behavior
//   Uses in-memory Queue mock + fake timers to avoid I/O ↔ timer impedance.
// ---------------------------------------------------------------------------
describe('flusher backoff', () => {
  let dir: string;
  let records: QueueRecord[];
  let mockQueue: Queue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-flush-backoff-'));
    vi.useFakeTimers();
    const mq = createMockQueue();
    records = mq.records;
    mockQueue = mq.queue;
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  // Test 4 — backoff actually doubles on consecutive failures (Edit B)
  it('doubles backoff 5/10/20/40/60 min on consecutive 5xx (Test 4)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      await mockQueue.append(makeRecord({ installId: identity.installId }));

      const calls: { at: number }[] = [];
      (globalThis as any).fetch = async (_url: string, _init: RequestInit) => {
        calls.push({ at: Date.now() });
        return new Response(null, { status: 500 });
      };

      const flusher = new Flusher({ queue: mockQueue, dir, endpoint: 'http://test/ingest' });

      // Call 1: manual flush → 5xx → schedule backoff at 5 min
      await flusher.flush();
      expect(calls).toHaveLength(1);

      // Calls 2-6: advance time by expected delay; timer fires flush() automatically
      const expectedDelays = [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000];
      for (const expectedDelay of expectedDelays) {
        await vi.advanceTimersByTimeAsync(expectedDelay);
      }

      expect(calls).toHaveLength(6);

      const gaps = [];
      for (let i = 1; i < calls.length; i++) {
        gaps.push(calls[i].at - calls[i - 1].at);
      }
      expect(gaps).toEqual([300_000, 600_000, 1_200_000, 2_400_000, 3_600_000]);
    } finally {
      restoreFetch(originalFetch);
    }
  });

  // Test 5 — successful drain resets backoff state (Edit B + Edit C, success-drain branch)
  it('resets backoff to 5 min after successful drain (Test 5)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      await mockQueue.append(makeRecord({ installId: identity.installId }));

      // Phase 1: 3 failures then success
      const responses = [500, 500, 500, 204];
      const calls: { at: number }[] = [];
      (globalThis as any).fetch = async (_url: string, _init: RequestInit) => {
        const status = responses.shift() ?? 500;
        calls.push({ at: Date.now() });
        return new Response(null, { status });
      };

      const flusher = new Flusher({ queue: mockQueue, dir, endpoint: 'http://test/ingest' });

      // Call 1: manual → 5xx → schedule 5 min
      await flusher.flush();
      expect(calls).toHaveLength(1);

      // Call 2: advance 5 min → 5xx → schedule 10 min
      await vi.advanceTimersByTimeAsync(300_000);
      expect(calls).toHaveLength(2);

      // Call 3: advance 10 min → 5xx → schedule 20 min
      await vi.advanceTimersByTimeAsync(600_000);
      expect(calls).toHaveLength(3);

      // Call 4: advance 20 min → 204 → success-drain → clearBackoff()
      await vi.advanceTimersByTimeAsync(1_200_000);
      expect(calls).toHaveLength(4);

      // After success: backoff cleared
      expect(flusher.backoffActive).toBe(false);

      // Phase 2: append record B, trigger fresh failure
      await mockQueue.append(makeRecord({ installId: identity.installId }));
      responses.push(500, 500);

      // Post-success failure 1: manual flush → 5xx
      await flusher.flush();
      expect(calls).toHaveLength(5);
      const t0 = calls[4].at;

      // Advance by INITIAL_BACKOFF_MS — retry fires
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
      expect(calls).toHaveLength(6);
      const t1 = calls[5].at;

      // Gap is 5 min (fresh backoff after reset), NOT 40 min from stale state
      expect(t1 - t0).toBe(INITIAL_BACKOFF_MS);
      expect(flusher.backoffActive).toBe(true);
    } finally {
      restoreFetch(originalFetch);
    }
  });

  // Test 6 — empty-queue path clears stale backoff (Edit C, empty-queue branch)
  it('clears stale backoff when queue is emptied before retry (Test 6)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      await mockQueue.append(makeRecord({ installId: identity.installId }));

      const responses = [500];
      const calls: { at: number }[] = [];
      (globalThis as any).fetch = async (_url: string, _init: RequestInit) => {
        const status = responses.shift() ?? 500;
        calls.push({ at: Date.now() });
        return new Response(null, { status });
      };

      const flusher = new Flusher({ queue: mockQueue, dir, endpoint: 'http://test/ingest' });

      // Flush fails → backoff scheduled at 5 min
      await flusher.flush();
      expect(calls).toHaveLength(1);
      expect(flusher.backoffActive).toBe(true);

      // Empty queue out-of-band (simulates record ack'd by another process)
      const batch = await mockQueue.readBatch(50);
      await mockQueue.truncate(batch.meta);

      // Advance time: retry fires, hits empty-queue return, clearBackoff()
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
      expect(calls).toHaveLength(1); // no additional fetch calls
      expect(flusher.backoffActive).toBe(false);

      // Append record B and trigger fresh failure
      await mockQueue.append(makeRecord({ installId: identity.installId }));
      responses.push(500, 500);

      await flusher.flush();
      expect(calls).toHaveLength(2);
      const t0 = calls[1].at;

      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
      expect(calls).toHaveLength(3);
      const t1 = calls[2].at;

      // Gap is fresh 5 min, NOT 10 min (stale doubled from original failure)
      expect(t1 - t0).toBe(INITIAL_BACKOFF_MS);
    } finally {
      restoreFetch(originalFetch);
    }
  });

  // Test 7 — 5xx still triggers backoff (negative regression guard)
  it('5xx triggers backoff and does not drop records (Test 7)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const identity = getOrCreateIdentity(dir);
      await mockQueue.append(makeRecord({ installId: identity.installId }));

      (globalThis as any).fetch = async (_url: string, _init: RequestInit) => {
        return new Response(null, { status: 500 });
      };

      const flusher = new Flusher({ queue: mockQueue, dir, endpoint: 'http://test/ingest' });
      await flusher.flush();

      expect(flusher.backoffActive).toBe(true);
      expect(flusher.dropped).toBe(0);

      const batch = await mockQueue.readBatch(50);
      expect(batch.records).toHaveLength(1);
    } finally {
      restoreFetch(originalFetch);
    }
  });
});
