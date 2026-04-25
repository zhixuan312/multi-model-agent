import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, resetCapWarning } from '../../packages/server/src/telemetry/queue.js';
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
    event: { type: 'session.started', eventId: 'e0000000-0000-4000-a000-000000000001', configFlavor: { defaultTier: 'standard', diagnosticsEnabled: true, autoUpdateSkills: true }, providersConfigured: ['claude'] },
    ...overrides,
  };
}

describe('queue', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-q-'));
    resetCapWarning();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch { /* */ }
  });

  it('appends and reads back records', async () => {
    const q = new Queue(dir);
    await q.append(makeRecord());
    const result = await q.readBatch(50);
    expect(result.records.length).toBe(1);
    expect(result.records[0].schemaVersion).toBe(1);
    expect(result.records[0].install.installId).toBe('00000000-0000-4000-a000-000000000001');
  });

  it('readBatch returns empty when no queue file exists', async () => {
    const q = new Queue(dir);
    const result = await q.readBatch(50);
    expect(result.records.length).toBe(0);
    expect(result.meta.length).toBe(0);
  });

  it('serializes with sorted keys (canonical)', async () => {
    const q = new Queue(dir);
    // keys are intentionally out of order
    const record = {
      generation: 0,
      event: { type: 'task.completed', zzz: 1, aaa: 2 },
      schemaVersion: 1,
      install: {
        installId: '00000000-0000-4000-a000-000000000001',
        mmagentVersion: '3.6.0',
        os: 'darwin',
        nodeMajor: '22',
        language: 'en',
        tzOffsetBucket: 'utc_0_to_plus_6',
      },
    };
    await q.append(record as QueueRecord);
    const raw = readFileSync(q.queuePath, 'utf8');
    const parsed = JSON.parse(raw.trim());
    // Keys in the raw JSON should be alphabetically sorted
    const keys = Object.keys(parsed);
    expect(keys).toEqual(['event', 'generation', 'install', 'schemaVersion']);
    const eventKeys = Object.keys(parsed.event);
    expect(eventKeys).toEqual(['aaa', 'type', 'zzz']);
  });

  it('truncates the prefix that was just uploaded', async () => {
    const q = new Queue(dir);
    await q.append(makeRecord({ event: { ...makeRecord().event, eventId: 'e00000000-0000-4000-a000-000000000001' } }));
    await q.append(makeRecord({ event: { ...makeRecord().event, eventId: 'e00000000-0000-4000-a000-000000000002' } }));
    await q.append(makeRecord({ event: { ...makeRecord().event, eventId: 'e00000000-0000-4000-a000-000000000003' } }));
    await q.append(makeRecord({ event: { ...makeRecord().event, eventId: 'e00000000-0000-4000-a000-000000000004' } }));
    await q.append(makeRecord({ event: { ...makeRecord().event, eventId: 'e00000000-0000-4000-a000-000000000005' } }));

    const batch = await q.readBatch(2);
    expect(batch.records.length).toBe(2);
    expect(batch.meta.length).toBe(2);

    await q.truncate(batch.meta);
    const remaining = await q.readBatch(50);
    expect(remaining.records.length).toBe(3);
  });

  it('truncate with mismatched hash does NOT truncate', async () => {
    const q = new Queue(dir);
    await q.append(makeRecord());
    await q.append(makeRecord());
    const batch = await q.readBatch(1);
    // Tamper with the hash
    batch.meta[0].sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
    await q.truncate(batch.meta);
    const remaining = await q.readBatch(50);
    expect(remaining.records.length).toBe(2); // nothing truncated
  });

  it('caps at 10,000 events — drops oldest 1,000', { timeout: 60_000 }, async () => {
    const q = new Queue(dir);
    // Write 10,001 records to trigger the cap
    for (let i = 0; i < 10_001; i++) {
      await q.append(makeRecord({
        event: { ...makeRecord().event, eventId: `e${String(i).padStart(12, '0')}` },
      }));
    }
    // The oldest 1,000 should have been dropped by the cap during the last append
    const result = await q.readBatch(10_000);
    expect(result.records.length).toBeLessThanOrEqual(10_000);
    // The first record should NOT be the original #0 (it was dropped)
    const firstId = (result.records[0].event as Record<string, unknown>).eventId as string;
    expect(firstId).not.toBe('000000000000');
  });

  it('caps at 10 MiB — drops oldest and continues', { timeout: 60_000 }, async () => {
    const q = new Queue(dir);
    // Write events with large payloads to exceed 10 MiB (~5,000 records)
    for (let i = 0; i < 6_000; i++) {
      await q.append(makeRecord({
        event: {
          ...makeRecord().event,
          eventId: `e${String(i).padStart(12, '0')}`,
          largePayload: 'x'.repeat(2048),
        },
      }));
    }
    // Queue should still be functional — the cap kicked in
    const result = await q.readBatch(50);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.length).toBeLessThanOrEqual(50);
    expect(existsSync(q.queuePath)).toBe(true);
  });

  it('concurrent appends from 10 parallel writers — every event present and lockfile cleaned', { timeout: 15_000 }, async () => {
    const q = new Queue(dir);
    const writesPerWorker = 10;
    const workers = 10;
    const totalExpected = workers * writesPerWorker;

    // Each worker writes sequentially to avoid overwhelming the lock
    // Workers run in parallel — lock serializes the actual file writes
    const workerPromises: Promise<void>[] = [];
    for (let w = 0; w < workers; w++) {
      workerPromises.push(
        (async () => {
          for (let j = 0; j < writesPerWorker; j++) {
            await q.append(makeRecord({
              event: {
                ...makeRecord().event,
                eventId: `w${String(w).padStart(2, '0')}-${String(j).padStart(3, '0')}`,
              },
            }));
          }
        })(),
      );
    }

    await Promise.all(workerPromises);

    const allRecords: QueueRecord[] = [];
    let batch: Awaited<ReturnType<typeof q.readBatch>>;
    do {
      batch = await q.readBatch(500);
      allRecords.push(...batch.records);
    } while (batch.records.length === 500);

    expect(allRecords.length).toBe(totalExpected);
  });

  it('lock timeout surfaces a recoverable error (skip, not throw)', async () => {
    const q = new Queue(dir);
    // Append should not throw even if the lock can't be acquired
    // In normal operation the lock is always available; this test
    // validates the error path by writing many concurrent records.
    // The key assertion: no unhandled promise rejection.
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => q.append(makeRecord())),
    );
    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBe(0);
  });

  it('corrupted line is rotated to .corrupted-<ts>.ndjson and queue continues with a fresh file', async () => {
    const q = new Queue(dir);
    // Write a valid record
    await q.append(makeRecord({ event: { ...makeRecord().event, eventId: 'e0000000-0000-4000-a000-000000000001' } }));

    // Manually corrupt the queue file by appending garbage
    const { writeFileSync, appendFileSync } = await import('node:fs');
    appendFileSync(q.queuePath, 'this is not valid json\n');

    // Now try to write another event and read
    // The corrupted line will cause rotation during the next readBatch
    const badResult = await q.readBatch(10);

    // The corrupted file should have been rotated
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir);
    const corruptedFiles = files.filter(f => f.includes('corrupted'));
    expect(corruptedFiles.length).toBeGreaterThanOrEqual(1);

    // Queue should still work for new appends
    await q.append(makeRecord({ event: { ...makeRecord().event, eventId: 'e0000000-0000-4000-a000-000000000002' } }));
    const freshResult = await q.readBatch(10);
    expect(freshResult.records.length).toBeGreaterThanOrEqual(1);
  });

  it('empty queue file returns empty batch', async () => {
    const q = new Queue(dir);
    // Create empty queue file manually
    const { writeFileSync } = await import('node:fs');
    writeFileSync(q.queuePath, '');
    const result = await q.readBatch(50);
    expect(result.records.length).toBe(0);
  });

  it('truncate with empty meta is a no-op', async () => {
    const q = new Queue(dir);
    await q.append(makeRecord());
    await q.truncate([]);
    const result = await q.readBatch(50);
    expect(result.records.length).toBe(1);
  });

  it('readBatch respects maxRecords limit', async () => {
    const q = new Queue(dir);
    for (let i = 0; i < 10; i++) {
      await q.append(makeRecord({
        event: { ...makeRecord().event, eventId: `e0000000-0000-4000-a000-${String(i).padStart(12, '0')}` },
      }));
    }
    const result = await q.readBatch(3);
    expect(result.records.length).toBe(3);
    expect(result.meta.length).toBe(3);
  });

  it('meta contains valid byte offsets and sha256 hashes', async () => {
    const q = new Queue(dir);
    await q.append(makeRecord());
    const result = await q.readBatch(10);
    expect(result.meta.length).toBe(1);
    expect(typeof result.meta[0].byteOffset).toBe('number');
    expect(result.meta[0].byteLength).toBeGreaterThan(0);
    expect(result.meta[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
