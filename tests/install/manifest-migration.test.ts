import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendEntry,
  listEntries,
  manifestPath,
  FutureManifestError,
} from '../../packages/server/src/install/manifest.js';

function mkHome(content?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'mfm-'));
  mkdirSync(join(home, '.multi-model'), { recursive: true });
  if (content !== undefined) {
    writeFileSync(join(home, '.multi-model', 'install-manifest.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return home;
}

describe('manifest v1 → v2 migration', () => {
  it('missing file behaves as empty v2', () => {
    const home = mkHome();
    expect(listEntries(home)).toEqual([]);
  });

  it('v1 entries get skillVersion derived from legacy version field', () => {
    const home = mkHome({
      version: 1,
      entries: [{ name: 'mma-delegate', version: '3.0.0', installedAt: 100, targets: ['claude-code'] }],
    });
    const entries = listEntries(home);
    expect(entries[0]).toEqual({
      name: 'mma-delegate',
      skillVersion: '3.0.0',
      installedAt: 100,
      targets: ['claude-code'],
    });
    // Persisted v2 on disk
    const onDisk = JSON.parse(readFileSync(manifestPath(home), 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.entries[0].skillVersion).toBe('3.0.0');
  });

  it('v1 entry missing version field migrates to skillVersion="unknown"', () => {
    const home = mkHome({
      version: 1,
      entries: [{ name: 'mma-delegate', installedAt: 0, targets: ['claude-code'] }],
    });
    expect(listEntries(home)[0]!.skillVersion).toBe('unknown');
  });

  it('v2 is used as-is (idempotent)', () => {
    const home = mkHome({
      version: 2,
      entries: [{ name: 'mma-delegate', skillVersion: '3.1.0', installedAt: 200, targets: ['claude-code'] }],
    });
    const before = readFileSync(manifestPath(home), 'utf8');
    expect(listEntries(home)[0]!.skillVersion).toBe('3.1.0');
    // Reading twice must not change on-disk content
    listEntries(home);
    expect(readFileSync(manifestPath(home), 'utf8')).toBe(before);
  });

  it('future version throws FutureManifestError', () => {
    const home = mkHome({ version: 99, entries: [] });
    expect(() => listEntries(home)).toThrow(FutureManifestError);
    expect(() => listEntries(home)).toThrow(/newer mmagent/);
  });

  it('malformed JSON is backed up and rebuilt as empty v2', () => {
    const home = mkHome('{not valid json');
    expect(listEntries(home)).toEqual([]);
    // Original file replaced with empty v2
    const onDisk = JSON.parse(readFileSync(manifestPath(home), 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.entries).toEqual([]);
  });

  it('appendEntry writes v2 shape on fresh home', () => {
    const home = mkHome();
    appendEntry('mma-audit', '3.1.0', ['claude-code'], home);
    const onDisk = JSON.parse(readFileSync(manifestPath(home), 'utf8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.entries[0].skillVersion).toBe('3.1.0');
    expect('version' in onDisk.entries[0]).toBe(false);
  });
});
