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
      schemaVersion: 1,
      install: { installId: identity.installId, mmagentVersion: '0.2.0', os: 'linux', nodeMajor: '22', language: 'en', tzOffsetBucket: 'utc_0_to_plus_6' },
      generation: 0,
      event: { eventId: '11111111-1111-4111-8111-111111111111', eventType: 'task.completed', occurredAt: new Date().toISOString() },
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
});
