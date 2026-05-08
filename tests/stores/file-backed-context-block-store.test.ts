import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileBackedContextBlockStore } from '../../packages/core/src/stores/file-backed-context-block-store.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-blocks-'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('FileBackedContextBlockStore (Gap 4)', () => {
  it('persists across instances — survives daemon restart', () => {
    const store1 = new FileBackedContextBlockStore(tmpRoot);
    const { id } = store1.register('hello world');

    // Simulate daemon restart with a fresh instance pointed at the same root.
    const store2 = new FileBackedContextBlockStore(tmpRoot);
    expect(store2.get(id)).toBe('hello world');
  });

  it('round-trips: register → get → delete → get returns undefined', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    const { id } = store.register('content');
    expect(store.get(id)).toBe('content');
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
    expect(store.delete(id)).toBe(false);
  });

  it('returns undefined for unknown id without throwing', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('lazy-deletes on get when entry is past TTL', () => {
    const store = new FileBackedContextBlockStore(tmpRoot, { ttlMs: 1 });
    const { id } = store.register('x');

    // Backdate the meta file so the next get() sees it as expired.
    const metaPath = path.join(tmpRoot, '.mma', 'context-blocks', `${id}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.createdAt = Date.now() - 1000;
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    expect(store.get(id)).toBeUndefined();
    // Both files should be gone (lazy-delete).
    expect(fs.existsSync(metaPath)).toBe(false);
  });

  it('runIdleSweep evicts expired blocks; pinned entries survive', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    const { id: a } = store.register('a');
    const { id: b } = store.register('b');
    store.pin(b);

    // Backdate both metas — should be eligible for eviction.
    for (const id of [a, b]) {
      const metaPath = path.join(tmpRoot, '.mma', 'context-blocks', `${id}.meta.json`);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.createdAt = Date.now() - 1_000_000;
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    }

    const evicted = store.runIdleSweep(Date.now(), 1);
    expect(evicted).toBe(1); // only `a` evicted; `b` is pinned
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBe('b');
  });

  it('rejects blocks larger than maxBlockBytes (UTF-8 byte size)', () => {
    const store = new FileBackedContextBlockStore(tmpRoot, { maxBlockBytes: 16 });
    expect(() => store.register('x'.repeat(17))).toThrow(/per-block cap/);
  });

  it('uses UTF-8 byte length, not string length, for size cap', () => {
    // 4-byte UTF-8 codepoint × 5 = 20 bytes, but only 5 string chars.
    const store = new FileBackedContextBlockStore(tmpRoot, { maxBlockBytes: 16 });
    const fourByteChar = '\u{1F600}'; // 4 bytes in UTF-8
    expect(() => store.register(fourByteChar.repeat(5))).toThrow(/per-block cap/);
  });

  it('evicts oldest blocks when total cap is exceeded', () => {
    // Cap 200 bytes, three 80-byte blocks → first one evicted on 3rd register.
    const store = new FileBackedContextBlockStore(tmpRoot, { maxTotalBytes: 200 });
    const { id: a } = store.register('A'.repeat(80));
    // ensure timestamp ordering deterministic
    const metaA = path.join(tmpRoot, '.mma', 'context-blocks', `${a}.meta.json`);
    const aMeta = JSON.parse(fs.readFileSync(metaA, 'utf8'));
    aMeta.createdAt = Date.now() - 200;
    fs.writeFileSync(metaA, JSON.stringify(aMeta));

    const { id: b } = store.register('B'.repeat(80));
    const metaB = path.join(tmpRoot, '.mma', 'context-blocks', `${b}.meta.json`);
    const bMeta = JSON.parse(fs.readFileSync(metaB, 'utf8'));
    bMeta.createdAt = Date.now() - 100;
    fs.writeFileSync(metaB, JSON.stringify(bMeta));

    const { id: c } = store.register('C'.repeat(80));

    // `a` was oldest → evicted to make room for `c`.
    expect(store.get(a)).toBeUndefined();
    expect(store.get(b)).toBe('B'.repeat(80));
    expect(store.get(c)).toBe('C'.repeat(80));
  });

  it('writes content + meta with mode 0600; directory 0700', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    const { id } = store.register('secret');
    const dir = path.join(tmpRoot, '.mma', 'context-blocks');
    const contentPath = path.join(dir, `${id}.txt`);
    const metaPath = path.join(dir, `${id}.meta.json`);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(contentPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(metaPath).mode & 0o777).toBe(0o600);
  });

  it('cleans up orphans (content without meta) during sweep', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    const { id } = store.register('content');

    // Simulate a half-write SIGKILL recovery: meta file goes away.
    const metaPath = path.join(tmpRoot, '.mma', 'context-blocks', `${id}.meta.json`);
    fs.unlinkSync(metaPath);

    const evicted = store.runIdleSweep(Date.now(), 1_000_000);
    expect(evicted).toBe(1);
    expect(fs.existsSync(path.join(tmpRoot, '.mma', 'context-blocks', `${id}.txt`))).toBe(false);
  });

  it('size returns entry count', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    expect(store.size).toBe(0);
    store.register('a');
    store.register('b');
    expect(store.size).toBe(2);
  });

  it('clear() wipes all entries + pin counts', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    const { id: a } = store.register('a');
    store.register('b');
    store.pin(a);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.refcount(a)).toBe(0);
  });

  it('atomic write recovers from concurrent register on same id (overwrite)', () => {
    const store = new FileBackedContextBlockStore(tmpRoot);
    const { id } = store.register('first');
    store.register('second', { id });
    expect(store.get(id)).toBe('second');
  });
});
