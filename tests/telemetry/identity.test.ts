import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateIdentity, sign } from '../../packages/server/src/telemetry/identity.js';
import { createPublicKey, verify as edVerify } from 'node:crypto';

describe('identity', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-id-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates identity on first call with mode 0600', () => {
    const id = getOrCreateIdentity(dir);
    expect(id.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.privateKeyPkcs8).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(id.publicKeyRaw).toMatch(/^[A-Za-z0-9+/=]+$/);
    const path = join(dir, 'identity.json');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('returns the same identity on subsequent calls', () => {
    const a = getOrCreateIdentity(dir);
    const b = getOrCreateIdentity(dir);
    expect(b.installId).toBe(a.installId);
    expect(b.privateKeyPkcs8).toBe(a.privateKeyPkcs8);
  });

  it('regenerates if file is corrupt', () => {
    const a = getOrCreateIdentity(dir);
    writeFileSync(join(dir, 'identity.json'), 'garbage');
    const b = getOrCreateIdentity(dir);
    expect(b.installId).not.toBe(a.installId);
  });

  it('rotates identity when older than 365 days', () => {
    const a = getOrCreateIdentity(dir);
    const path = join(dir, 'identity.json');
    const stale = JSON.parse(readFileSync(path, 'utf8'));
    stale.generatedAt = new Date(Date.now() - 366 * 24 * 3600 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(stale), { mode: 0o600 });
    const b = getOrCreateIdentity(dir);
    expect(b.installId).not.toBe(a.installId);
    expect(b.privateKeyPkcs8).not.toBe(a.privateKeyPkcs8);
  });

  it('keeps identity when under 365 days', () => {
    const a = getOrCreateIdentity(dir);
    const path = join(dir, 'identity.json');
    const fresh = JSON.parse(readFileSync(path, 'utf8'));
    fresh.generatedAt = new Date(Date.now() - 364 * 24 * 3600 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(fresh), { mode: 0o600 });
    const b = getOrCreateIdentity(dir);
    expect(b.installId).toBe(a.installId);
  });
});

describe('sign', () => {
  it('produces a valid Ed25519 signature verifiable with the public key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-sig-'));
    try {
      const id = getOrCreateIdentity(dir);
      const body = JSON.stringify({ hello: 'world', n: 42 });
      const sig = sign(id.privateKeyPkcs8, body);
      const key = createPublicKey({
        key: Buffer.from(id.publicKeyRaw, 'base64'),
        format: 'der',
        type: 'spki',
      });
      expect(edVerify(null, Buffer.from(body, 'utf8'), key, Buffer.from(sig, 'base64'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when body is tampered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-tamper-'));
    try {
      const id = getOrCreateIdentity(dir);
      const sig = sign(id.privateKeyPkcs8, '{"a":1}');
      const key = createPublicKey({
        key: Buffer.from(id.publicKeyRaw, 'base64'),
        format: 'der',
        type: 'spki',
      });
      expect(edVerify(null, Buffer.from('{"a":2}', 'utf8'), key, Buffer.from(sig, 'base64'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
