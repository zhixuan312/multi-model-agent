/**
 * Byte offsets must index bytes.
 *
 * `truncate()` and `#enforceCap()` compute how much of the queue file to drop with
 * `Buffer.byteLength` — byte offsets — and then cut the remainder with `String.prototype.slice`,
 * which indexes UTF-16 code units. The two agree only while every queued event is pure ASCII.
 *
 * One `é`, one em dash, one non-Latin character anywhere in an event and the cut landed mid-record:
 * the remainder began partway through the next line, the following `readBatch` failed to parse it,
 * and `#rotateCorrupted()` moved the whole file aside. A SUCCESSFUL flush destroyed every event
 * still queued behind it — silently, with no error and no log, on any install whose telemetry was
 * not entirely ASCII. Model names carry em dashes; `errorMessage` carries file paths.
 *
 * The existing queue tests all used ASCII payloads, so every one of them passed throughout.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../../packages/server/src/telemetry/queue.js';

function record(message: string) {
  return {
    schemaVersion: 6,
    installId: 'install-1',
    mmaVersion: '1.0.0',
    os: 'darwin' as const,
    nodeMajor: 22,
    generation: 0,
    events: [{ errorMessage: message }],
  };
}

/** Each of these is one JS code unit shorter than its UTF-8 length, which is the whole bug. */
const MULTIBYTE = 'déjà vu — 日本語 ✅';

describe('queue offsets with multi-byte payloads', () => {
  it('truncate cuts at a record boundary, leaving the rest readable', async () => {
    const queue = new Queue(mkdtempSync(join(tmpdir(), 'mma-queue-mb-')));
    await queue.append(record(MULTIBYTE));
    await queue.append(record('second record, pure ascii'));

    const batch = await queue.readBatch();
    expect(batch.records).toHaveLength(2);

    // Acknowledge only the first — exactly what the flusher does after a partial upload.
    await queue.truncate(batch.meta.slice(0, 1));

    const remaining = readFileSync(queue.queuePath, 'utf8');
    expect(remaining.startsWith('{'), `remainder began mid-record: ${remaining.slice(0, 40)}`).toBe(true);
    expect(remaining).not.toContain(MULTIBYTE);

    // The real proof: the survivor is still parseable, so the next read does not rotate it away.
    const after = await queue.readBatch();
    expect(after.records).toHaveLength(1);
    expect(after.records[0]!.events[0]!.errorMessage).toBe('second record, pure ascii');
  });

  it('a multi-byte record is not corrupted by truncating the one before it', async () => {
    const queue = new Queue(mkdtempSync(join(tmpdir(), 'mma-queue-mb2-')));
    await queue.append(record('first, ascii'));
    await queue.append(record(MULTIBYTE));

    const batch = await queue.readBatch();
    await queue.truncate(batch.meta.slice(0, 1));

    const after = await queue.readBatch();
    expect(after.records).toHaveLength(1);
    expect(after.records[0]!.events[0]!.errorMessage).toBe(MULTIBYTE);
  });
});
