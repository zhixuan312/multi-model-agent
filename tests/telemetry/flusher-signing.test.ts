import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Queue } from '../../packages/server/src/telemetry/queue.js';
import { Flusher } from '../../packages/server/src/telemetry/flusher.js';
import { getOrCreateIdentity } from '../../packages/server/src/telemetry/identity.js';

describe('flusher signing', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-flush-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('sets X-Mmagent-Install-Id, X-Mmagent-Signature, X-Mmagent-Pubkey on every batch', async () => {
    const identity = getOrCreateIdentity(dir);
    const queue = new Queue(dir);
    await queue.append({
      schemaVersion: 4,
      installId: identity.installId,
      mmagentVersion: '0.2.0',
      os: 'linux',
      nodeMajor: 22,
      generation: 0,
      events: [{ eventId: '11111111-1111-4111-8111-111111111111', eventType: 'task.completed', occurredAt: new Date().toISOString() }],
    });
    let captured!: { headers: Record<string, string>; body: Buffer };
    const fakeServer = { fetch: async (_url: string, init: RequestInit) => {
      captured = { headers: init.headers as Record<string, string>, body: init.body as Buffer };
      return new Response(null, { status: 204 });
    }};
    (globalThis as any).fetch = fakeServer.fetch;
    const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
    await flusher.flush();
    expect(captured.headers['X-Mmagent-Install-Id']).toBe(identity.installId);
    expect(typeof captured.headers['X-Mmagent-Signature']).toBe('string');
    expect(captured.headers['X-Mmagent-Pubkey']).toBe(identity.publicKeyRaw);
    // Verify signature against the gunzipped JSON body (not the gzipped bytes).
    const json = gunzipSync(captured.body).toString('utf8');
    const key = createPublicKey({ key: Buffer.from(identity.publicKeyRaw, 'base64'), format: 'der', type: 'spki' });
    expect(edVerify(null, Buffer.from(json, 'utf8'), key, Buffer.from(captured.headers['X-Mmagent-Signature'], 'base64'))).toBe(true);
  });

  it('drops legacy-schema records at the queue head and unblocks subsequent V3 records', async () => {
    const identity = getOrCreateIdentity(dir);
    const queue = new Queue(dir);
    // Two legacy records (V1, V2) stuck at the head — these would 401 forever.
    await (queue.append as any)({ schemaVersion: 1, install: { installId: identity.installId, mmagentVersion: '0.2.0', os: 'linux', nodeMajor: '22' }, generation: 0, event: { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } });
    await (queue.append as any)({ schemaVersion: 2, install: { installId: identity.installId, mmagentVersion: '1.0.0', os: 'linux', nodeMajor: '22' }, generation: 0, events: [{ eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] });
    // One current-schema record behind them.
    await queue.append({
      schemaVersion: 4,
      installId: identity.installId,
      mmagentVersion: '3.10.0',
      os: 'linux',
      nodeMajor: 22,
      generation: 0,
      events: [{ eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    });

    const calls: { body: Buffer }[] = [];
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      calls.push({ body: init.body as Buffer });
      return new Response(null, { status: 204 });
    };

    const flusher = new Flusher({ queue, dir, endpoint: 'http://test/ingest' });
    await flusher.flush();

    // Only the V3 record should reach the wire.
    expect(calls).toHaveLength(1);
    const sentJson = JSON.parse(gunzipSync(calls[0].body).toString('utf8'));
    expect(sentJson.schemaVersion).toBe(4);
    expect(sentJson.events).toHaveLength(1);
    expect(sentJson.events[0].eventId).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');

    // Queue should be fully drained — both legacy records dropped, V3 acked.
    const remaining = await queue.readBatch(50);
    expect(remaining.records).toHaveLength(0);
  });
});
