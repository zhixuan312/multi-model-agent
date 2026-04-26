import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateInstallId, hasInstallId, deleteInstallId } from '../../packages/server/src/telemetry/install-id.js';

describe('install-id', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mma-test-')); });

  it('returns a UUIDv4 and creates the file with mode 0600', () => {
    const id = getOrCreateInstallId(dir);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(statSync(join(dir,'install-id')).mode & 0o777).toBe(0o600);
  });

  it('is idempotent — second call returns the same UUID', () => {
    const a = getOrCreateInstallId(dir);
    const b = getOrCreateInstallId(dir);
    expect(b).toBe(a);
  });

  it('hasInstallId is false before first call', () => {
    expect(hasInstallId(dir)).toBe(false);
    getOrCreateInstallId(dir);
    expect(hasInstallId(dir)).toBe(true);
  });

  it('deleteInstallId removes the file', () => {
    getOrCreateInstallId(dir);
    deleteInstallId(dir);
    expect(existsSync(join(dir,'install-id'))).toBe(false);
  });

  it('two parallel getOrCreateInstallId calls converge on the same UUID', async () => {
    const ids = await Promise.all([
      Promise.resolve().then(() => getOrCreateInstallId(dir)),
      Promise.resolve().then(() => getOrCreateInstallId(dir)),
      Promise.resolve().then(() => getOrCreateInstallId(dir)),
    ]);
    expect(new Set(ids).size).toBe(1);
  });
});
