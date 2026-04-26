import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateIdentity } from '../../packages/server/src/telemetry/identity.js';

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
});
