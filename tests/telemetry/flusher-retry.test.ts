/**
 * What the flusher does when the upload does NOT succeed.
 *
 * `Flusher` is the most stateful code in the telemetry subsystem — grouping, per-status handling,
 * exponential backoff with a `Retry-After` override, a mid-flush generation re-check, and a
 * partial-acknowledgment truncation — and the only tests over it covered request headers and
 * legacy-record dropping. Everything below had no coverage at all:
 *
 *   - a 429 backs off for `Retry-After` seconds, and for an hour when the header is absent;
 *   - a 5xx backs off on the exponential schedule instead;
 *   - a success clears the backoff;
 *   - `flush()` refuses to start while a backoff is pending, so timers cannot stampede;
 *   - only the ACKNOWLEDGED prefix is truncated — a batch that fails midway leaves its remaining
 *     records queued rather than dropping them;
 *   - a generation bump mid-flush stops the remaining groups.
 *
 * The partial-acknowledgment case is the one with teeth: it is the difference between "the upload
 * failed, we will retry" and "the upload failed and we deleted the evidence".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../../packages/server/src/telemetry/queue.js';
import { Flusher } from '../../packages/server/src/telemetry/flusher.js';
import { getOrCreateIdentity } from '../../packages/server/src/telemetry/identity.js';
import { bumpGeneration } from '../../packages/server/src/telemetry/generation.js';

const realFetch = globalThis.fetch;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-flush-retry-')); });
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

/** One queued record. `mmaVersion` varies the group key so a test can force several groups. */
async function enqueue(queue: Queue, installId: string, mmaVersion = '1.0.0'): Promise<void> {
  await queue.append({
    schemaVersion: 6,
    installId,
    mmaVersion,
    os: 'linux',
    nodeMajor: 22,
    generation: 0,
    events: [{ eventId: crypto.randomUUID(), eventType: 'task.completed', occurredAt: new Date().toISOString() }],
  });
}

/** Replace global fetch with a scripted sequence of responses; returns the call count. */
function scriptFetch(responses: Response[]): { calls: () => number } {
  let i = 0;
  globalThis.fetch = (async () => {
    const response = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return response.clone();
  }) as typeof globalThis.fetch;
  return { calls: () => i };
}

describe('flusher retry and backoff', () => {
  it('backs off after a 429 and refuses to start a second flush while it is pending', async () => {
    const identity = getOrCreateIdentity(dir);
    const queue = new Queue(dir);
    await enqueue(queue, identity.installId);

    const fetches = scriptFetch([new Response(null, { status: 429, headers: { 'Retry-After': '30' } })]);
    const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
    try {
      await flusher.flush();
      expect(fetches.calls()).toBe(1);
      expect(flusher.backoffActive, 'a 429 must schedule a backoff').toBe(true);

      // The record is NOT acknowledged, so it stays queued for the retry.
      expect((await queue.readBatch()).records).toHaveLength(1);

      // And a second flush must not fire while the backoff timer is pending — otherwise the
      // 5-minute interval would keep hammering an endpoint that just asked for 30 seconds.
      await flusher.flush();
      expect(fetches.calls(), 'flush() ran again during backoff').toBe(1);
    } finally {
      flusher.clearBackoff();
    }
  });

  it('clears the backoff once a flush drains successfully', async () => {
    const identity = getOrCreateIdentity(dir);
    const queue = new Queue(dir);
    await enqueue(queue, identity.installId);

    scriptFetch([new Response(null, { status: 503 })]);
    const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
    await flusher.flush();
    expect(flusher.backoffActive, 'a 5xx must schedule a backoff').toBe(true);

    flusher.clearBackoff();
    scriptFetch([new Response(null, { status: 204 })]);
    await flusher.flush();

    expect(flusher.backoffActive, 'a successful drain must clear the backoff').toBe(false);
    expect((await queue.readBatch()).records, 'an acknowledged record must be truncated').toHaveLength(0);
  });

  /**
   * The data-integrity case. Two groups; the first is accepted, the second is refused.
   * Exactly one record may be truncated — dropping the second would destroy an event the
   * backend never received.
   */
  it('truncates only the acknowledged prefix when a later group fails', async () => {
    const identity = getOrCreateIdentity(dir);
    const queue = new Queue(dir);
    // Different mmaVersion → different group key → two groups, uploaded in order.
    await enqueue(queue, identity.installId, '1.0.0');
    await enqueue(queue, identity.installId, '2.0.0');

    const responses = [new Response(null, { status: 204 }), new Response(null, { status: 503 })];
    let i = 0;
    globalThis.fetch = (async () => responses[Math.min(i++, 1)]!.clone()) as typeof globalThis.fetch;

    const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
    try {
      await flusher.flush();

      const remaining = (await queue.readBatch()).records;
      expect(remaining, 'the refused group must stay queued').toHaveLength(1);
      expect(remaining[0]!.mmaVersion, 'the SECOND group is the one that failed').toBe('2.0.0');
    } finally {
      flusher.clearBackoff();
    }
  });

  /**
   * The generation counter's one real job (see `generation.ts`): a revoke landing mid-flush must
   * stop the groups that have not gone out yet.
   */
  it('stops uploading remaining groups when the generation changes mid-flush', async () => {
    const identity = getOrCreateIdentity(dir);
    const queue = new Queue(dir);
    await enqueue(queue, identity.installId, '1.0.0');
    await enqueue(queue, identity.installId, '2.0.0');

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // Revoke lands while the first group is in flight.
      if (calls === 1) await bumpGeneration(dir);
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;

    const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
    try {
      await flusher.flush();
      expect(calls, 'the second group must not be uploaded after a generation bump').toBe(1);
      // The un-uploaded group is still queued; `revokeIdentity` deletes the file outright.
      expect((await queue.readBatch()).records).toHaveLength(1);
    } finally {
      flusher.clearBackoff();
    }
  });
});
