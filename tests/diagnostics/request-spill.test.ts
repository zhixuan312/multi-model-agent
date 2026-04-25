import { spillRequestBody } from '@zhixuan92/multi-model-agent-core/diagnostics/request-spill';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('spillRequestBody', () => {
  const validUuid = '11111111-1111-4111-8111-111111111111';
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const d of cleanupDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    cleanupDirs = [];
  });

  it('writes body to <dir>/<batch>.json with mode 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-test-'));
    cleanupDirs.push(dir);
    const result = await spillRequestBody({ dir, batch: validUuid, body: { hello: 'world' } });
    expect(result.path).toBe(join(dir, `${validUuid}.json`));
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toEqual({ hello: 'world' });
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(result.bytes).toBe(Buffer.byteLength('{"hello":"world"}', 'utf8'));
  });

  it('uses byte length not char length', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-test-'));
    cleanupDirs.push(dir);
    const result = await spillRequestBody({ dir, batch: validUuid, body: { emoji: '🚀' } });
    expect(result.bytes).toBeGreaterThan('{"emoji":"🚀"}'.length);
  });

  it('rejects non-UUID batch (path-traversal guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-test-'));
    cleanupDirs.push(dir);
    await expect(spillRequestBody({ dir, batch: '../etc/passwd', body: {} })).rejects.toThrow(/UUID/);
  });
});
