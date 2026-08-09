import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { CorpusIndex } from '../../packages/core/src/journal/engine/index-store.js';

/**
 * Concurrent journal access must not crash a task.
 *
 * Reported from real use: two `journal_recall` legs running at once both called
 * `CorpusIndex.syncIncremental()`, and the loser died with `runner_crash`. Recall is the
 * common path — it runs on every flow — so a crash under concurrency is a task-loss bug,
 * not a rare edge case.
 *
 * Two faults combined in the original implementation, and both had to be fixed:
 *
 *  1. All file reading and decoding happened INSIDE the transaction, so the write lock was
 *     held for as long as it took to read the corpus. `PRAGMA busy_timeout = 5000` cannot
 *     absorb a window that grows with corpus size.
 *  2. The transaction was a DEFERRED `BEGIN`, which takes a read lock and must upgrade to a
 *     write lock at its first write. SQLite fails that upgrade with SQLITE_BUSY immediately
 *     and does NOT honour `busy_timeout`, because waiting while holding a read lock could
 *     deadlock two upgraders. `BEGIN IMMEDIATE` is the case `busy_timeout` retries.
 *
 * The behavioural tests below are the real guard; the source assertions pin the two
 * structural properties that a future refactor could silently undo while still passing the
 * behavioural tests on a fast machine.
 */

function plainAdapter(root: string, files: string[]) {
  return {
    corpusId: 'plain',
    root,
    listFiles: async () => [...files],
    decode: async (relPath: string, raw: string) => ({ id: relPath, path: relPath, title: relPath, body: raw }),
    signals: () => [],
  };
}

/** A corpus big enough that reading it takes meaningfully longer than writing it — the
 *  condition under which holding the lock across I/O actually bites. */
async function seedCorpus(root: string, count: number): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = `note-${String(i).padStart(3, '0')}.txt`;
    await writeFile(join(root, name), `body for ${name} `.repeat(200));
    files.push(name);
  }
  return files;
}

describe('concurrent syncIncremental', () => {
  it('does not crash when several readers sync the same index at once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mma-concurrent-sync-'));
    try {
      const files = await seedCorpus(root, 40);

      // SEPARATE CorpusIndex instances, each with its own SQLite connection — the same
      // shape as separate recall legs. One shared instance would serialise inside the
      // process and prove nothing about cross-connection locking.
      const indexes = await Promise.all(
        Array.from({ length: 4 }, () => CorpusIndex.open({ root, adapter: plainAdapter(root, files) })),
      );
      await indexes[0]!.rebuild();

      // Every leg syncs at once. Before the fix this rejected with SQLITE_BUSY.
      const results = await Promise.allSettled(indexes.map((index) => index.syncIncremental()));
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected.map((r) => String((r as PromiseRejectedResult).reason)).join('\n')).toBe('');

      // Every leg must also still see the whole corpus: surviving the race is not enough
      // if a loser silently committed a partial view.
      for (const index of indexes) expect(index.allRecords().length).toBe(files.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stays consistent when readers sync while a writer changes files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mma-concurrent-write-'));
    try {
      const files = await seedCorpus(root, 25);
      const writer = await CorpusIndex.open({ root, adapter: plainAdapter(root, files) });
      await writer.rebuild();
      const readers = await Promise.all(
        Array.from({ length: 3 }, () => CorpusIndex.open({ root, adapter: plainAdapter(root, files) })),
      );

      // Mutate real files, then sync everything together — reads and the write race.
      await writeFile(join(root, files[0]!), 'rewritten body for the first note');
      await writeFile(join(root, files[1]!), 'rewritten body for the second note');

      const results = await Promise.allSettled([
        writer.syncIncremental(),
        ...readers.map((index) => index.syncIncremental()),
      ]);
      expect(results.filter((r) => r.status === 'rejected').length).toBe(0);

      // The change must be visible, and the record count must not drift.
      await writer.syncIncremental();
      expect(writer.allRecords().length).toBe(files.length);
      expect(writer.allRecords().find((r) => r.id === files[0])!.body).toContain('rewritten body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('takes no write lock at all when nothing changed', async () => {
    // The recall path syncs before every retrieval, and almost always finds nothing to do.
    // Opening a write transaction in that case would serialise concurrent readers for no
    // benefit — the very contention this fix removes.
    const root = await mkdtemp(join(tmpdir(), 'mma-nochange-sync-'));
    try {
      const files = await seedCorpus(root, 5);
      const index = await CorpusIndex.open({ root, adapter: plainAdapter(root, files) });
      await index.rebuild();

      const executed: string[] = [];
      const realExec = index['db'].exec.bind(index['db']);
      index['db'].exec = ((sql: string) => { executed.push(sql); return realExec(sql); }) as typeof realExec;

      await index.syncIncremental();
      expect(executed.filter((sql) => /^BEGIN/i.test(sql))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the two structural properties a refactor must not undo', () => {
  const source = () => readFileSync('packages/core/src/journal/engine/index-store.ts', 'utf8');

  it('uses BEGIN IMMEDIATE, never a bare deferred BEGIN, for the sync transaction', () => {
    const body = source();
    expect(body).toContain("BEGIN IMMEDIATE");
    // A bare `BEGIN` would reintroduce the lock-upgrade failure that busy_timeout cannot retry.
    expect(body).not.toContain("this.db.exec('BEGIN');");
  });

  it('performs no file I/O between BEGIN and COMMIT', () => {
    // Extract the transaction body and assert it awaits nothing from the filesystem. This is
    // the property that keeps the lock window proportional to write time, and a behavioural
    // test can pass on a fast machine even after it regresses.
    const body = source();
    const start = body.indexOf("this.db.exec('BEGIN IMMEDIATE')");
    const end = body.indexOf("this.db.exec('COMMIT')", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const transaction = body.slice(start, end);
    for (const io of ['await stat(', 'await readFile(', 'adapter.decode(', 'await adapter']) {
      expect(transaction, `file I/O inside the transaction: ${io}`).not.toContain(io);
    }
  });
});
