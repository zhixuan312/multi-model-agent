import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JournalStore } from '../../packages/core/src/journal/store.js';

// Controllable `fs.rename` stub: passes through unless `failOnCall` is set, then throws
// on that Nth call (counted from `calls`). Default `failOnCall: 0` = never fail, so every
// other test in this file writes/commits normally.
const renameControl = vi.hoisted(() => ({ calls: 0, failOnCall: 0 }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      renameControl.calls += 1;
      if (renameControl.failOnCall !== 0 && renameControl.calls === renameControl.failOnCall) {
        throw new Error('EIO: forced rename failure');
      }
      return actual.rename(from, to);
    },
  };
});

async function makeJournalRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mma-journal-store-'));
  await mkdir(join(root, 'nodes'), { recursive: true });
  await writeFile(join(root, 'schema.md'), '# schema\n');
  await writeFile(join(root, 'index.md'), '| id | timestamp | type | status | title | topic | tags |\n| --- | --- | --- | --- | --- | --- | --- |\n');
  await writeFile(join(root, 'log.md'), '');
  await writeFile(join(root, 'nodes', '0001-existing.md'), `---
id: "0001"
title: "Existing learning"
type: "process"
topic: "journal-engine"
status: "adopted"
description: "Existing."
timestamp: "2026-07-24T00:00:00.000Z"
tags:
  - existing
links: []
supersededBy: null
---

## Context

Existing.

## Consequences

- Existing.
`);
  return root;
}

describe('JournalStore', () => {
  it('creates, refines, supersedes, and merges records while preserving completeness', async () => {
    const root = await makeJournalRoot();
    const store = await JournalStore.open({ journalRoot: root });
    const result = await store.applyRecordBatch([
      {
        learning: 'Create a new deterministic writer.',
        decision: { kind: 'create', title: 'Deterministic writer', type: 'process', topic: 'journal-engine', tags: ['deterministic-writer'], links: [], status: 'adopted', description: 'Create path.', context: 'ctx', consequences: '- consequence' },
      },
      {
        learning: 'Supersede the existing learning.',
        decision: { kind: 'supersede', targetNodeId: '0001', title: 'Existing learning replacement', type: 'process', topic: 'journal-engine', tags: ['replacement'], links: [{ type: 'supersedes', target: '0001' }], status: 'adopted', description: 'Supersede path.', context: 'ctx', consequences: '- consequence' },
      },
      {
        learning: 'Merge without creating a node.',
        decision: { kind: 'merge', targetNodeId: '0001', reason: 'Already covered' },
      },
    ]);

    expect(result.recorded).toHaveLength(3);
    expect(result.failed).toEqual([]);
    expect(new Set(result.recorded.map((entry) => entry.learning)).size).toBe(3);
    const index = await readFile(join(root, 'index.md'), 'utf8');
    expect(index).toContain('| 0001 |');
    expect(index).toContain('| 0002 |');
    expect(index).toContain('| 0003 |');
    const log = await readFile(join(root, 'log.md'), 'utf8');
    expect(log).toContain('create  0002');
    expect(log).toContain('supersede  0003');
  });

  it('injects the refines edge for a refine decision even when the decision omits it', async () => {
    const root = await makeJournalRoot();
    const store = await JournalStore.open({ journalRoot: root });
    const result = await store.applyRecordBatch([
      {
        learning: 'Refine the existing learning.',
        decision: { kind: 'refine', targetNodeId: '0001', title: 'Refined learning', type: 'process', topic: 'journal-engine', tags: ['refined'], links: [], status: 'adopted', description: 'Refine path.', context: 'ctx', consequences: '- consequence' },
      },
    ]);
    expect(result.recorded).toHaveLength(1);
    const written = await readFile(join(root, result.recorded[0]!.nodePath), 'utf8');
    expect(written).toContain('type: "refines"');
    expect(written).toContain('target: "0001"');
    // A refine relates to the target but does NOT supersede it.
    const target = await readFile(join(root, 'nodes', '0001-existing.md'), 'utf8');
    expect(target).toContain('status: "adopted"');
    expect(target).toContain('supersededBy: null');
  });

  it('injects the supersedes edge and flips the target status for a supersede decision', async () => {
    const root = await makeJournalRoot();
    const store = await JournalStore.open({ journalRoot: root });
    const result = await store.applyRecordBatch([
      {
        learning: 'Supersede the existing learning.',
        decision: { kind: 'supersede', targetNodeId: '0001', title: 'Superseding learning', type: 'process', topic: 'journal-engine', tags: ['super'], links: [], status: 'adopted', description: 'Supersede path.', context: 'ctx', consequences: '- consequence' },
      },
    ]);
    const newId = result.recorded[0]!.nodeId;
    const written = await readFile(join(root, result.recorded[0]!.nodePath), 'utf8');
    expect(written).toContain('type: "supersedes"');
    expect(written).toContain('target: "0001"');
    const target = await readFile(join(root, 'nodes', '0001-existing.md'), 'utf8');
    expect(target).toContain('status: "superseded"');
    expect(target).toContain(`supersededBy: "${newId}"`);
  });

  it('leaves the pre-batch state untouched when a node temp-write fails mid-batch', async () => {
    const root = await makeJournalRoot();
    // Force the SECOND staged node's temp-write to fail by planting a directory at
    // its predictable temp path (nodes/0002-alpha.md.tmp) — writeFile → EISDIR.
    await mkdir(join(root, 'nodes', '0002-alpha.md.tmp'), { recursive: true });
    const store = await JournalStore.open({ journalRoot: root });
    await expect(store.applyRecordBatch([
      { learning: 'first', decision: { kind: 'create', title: 'Alpha', type: 'process', topic: 'journal-engine', tags: ['a'], links: [], status: 'adopted', description: 'a', context: 'ctx', consequences: '- a' } },
      { learning: 'second', decision: { kind: 'create', title: 'Beta', type: 'process', topic: 'journal-engine', tags: ['b'], links: [], status: 'adopted', description: 'b', context: 'ctx', consequences: '- b' } },
    ])).rejects.toThrow();

    // NO node file, index.md, or log.md was mutated from the pre-batch state.
    const existing = await readFile(join(root, 'nodes', '0001-existing.md'), 'utf8');
    expect(existing).toContain('Existing learning');
    await expect(readFile(join(root, 'nodes', '0002-alpha.md'), 'utf8')).rejects.toThrow();
    const index = await readFile(join(root, 'index.md'), 'utf8');
    expect(index).not.toContain('| 0002 |');
    expect(index).not.toContain('0002-alpha');
    const log = await readFile(join(root, 'log.md'), 'utf8');
    expect(log).toBe('');
  });

  it('serializes concurrent batches per journalRoot and allocates distinct ids', async () => {
    const root = await makeJournalRoot();
    const store = await JournalStore.open({ journalRoot: root });
    const mk = (title: string, tag: string) =>
      store.applyRecordBatch([
        {
          learning: title,
          decision: { kind: 'create', title, type: 'process', topic: 'journal-engine', tags: [tag], links: [], status: 'adopted', description: 'd', context: 'ctx', consequences: '- c' },
        },
      ]);
    // Fire two batches concurrently against the SAME store/journalRoot. Without a
    // per-journalRoot lock both snapshot {0001} and allocate 0002 → collision. With
    // the lock the second runs after the first commits and sees 0002 → allocates 0003.
    const [a, b] = await Promise.all([mk('Alpha', 'a'), mk('Beta', 'b')]);
    const ids = [a.recorded[0]!.nodeId, b.recorded[0]!.nodeId].sort();
    expect(ids).toEqual(['0002', '0003']);
    const files = await readdir(join(root, 'nodes'));
    expect(files.some((f) => f.startsWith('0002-'))).toBe(true);
    expect(files.some((f) => f.startsWith('0003-'))).toBe(true);
    const index = await readFile(join(root, 'index.md'), 'utf8');
    expect(index).toContain('| 0002 |');
    expect(index).toContain('| 0003 |');
  });

  it('rolls back to the exact pre-batch state when a rename fails mid-commit', async () => {
    const root = await makeJournalRoot();
    // Capture the exact pre-batch bytes of every pre-existing target.
    const existingBefore = await readFile(join(root, 'nodes', '0001-existing.md'), 'utf8');
    const indexBefore = await readFile(join(root, 'index.md'), 'utf8');
    const logBefore = await readFile(join(root, 'log.md'), 'utf8');

    const store = await JournalStore.open({ journalRoot: root });
    // Fail specifically DURING the rename phase (not the temp-write phase) on the 3rd
    // rename: artifacts commit in order [0001-existing (overwrite), 0002-alpha (new),
    // index.md (overwrite), log.md] — so by the throw, 0001 has been overwritten and
    // 0002 newly created, exercising BOTH rollback branches (restore-overwritten +
    // delete-new). index.md/log.md are never renamed.
    renameControl.calls = 0;
    renameControl.failOnCall = 3;
    try {
      await expect(store.applyRecordBatch([
        { learning: 'first', decision: { kind: 'create', title: 'Alpha', type: 'process', topic: 'journal-engine', tags: ['a'], links: [], status: 'adopted', description: 'a', context: 'ctx', consequences: '- a' } },
        { learning: 'second', decision: { kind: 'create', title: 'Beta', type: 'process', topic: 'journal-engine', tags: ['b'], links: [], status: 'adopted', description: 'b', context: 'ctx', consequences: '- b' } },
      ])).rejects.toThrow();
    } finally {
      renameControl.failOnCall = 0;
    }

    // Every pre-existing target is byte-identical to its pre-batch content — even the
    // ones renamed-then-rolled-back — and no partial new node remains.
    expect(await readFile(join(root, 'nodes', '0001-existing.md'), 'utf8')).toBe(existingBefore);
    expect(await readFile(join(root, 'index.md'), 'utf8')).toBe(indexBefore);
    expect(await readFile(join(root, 'log.md'), 'utf8')).toBe(logBefore);
    await expect(readFile(join(root, 'nodes', '0002-alpha.md'), 'utf8')).rejects.toThrow();
    // No leftover staging files remain in either directory.
    expect((await readdir(join(root, 'nodes'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('skips a genuinely malformed node during bulk read and still loads the good ones', async () => {
    const root = await makeJournalRoot();
    // Plant a garbage node (missing required frontmatter fields) alongside the good 0001.
    await writeFile(join(root, 'nodes', '0099-broken.md'), `---
id: "0099"
type: "process"
---

## Context

Malformed: missing title/topic/status/timestamp.
`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = await JournalStore.open({ journalRoot: root });
      // rebuildCatalog bulk-reads every node via loadNodes(); the bad one must not throw.
      const count = await store.rebuildCatalog();
      expect(count).toBe(1); // only the good 0001 survived
      const index = await readFile(join(root, 'index.md'), 'utf8');
      expect(index).toContain('| 0001 |');
      expect(index).not.toContain('| 0099 |');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('0099-broken.md'));
    } finally {
      warn.mockRestore();
    }
  });

  it('rolls back all markdown mutations when a batch invariant fails', async () => {
    const root = await makeJournalRoot();
    const store = await JournalStore.open({ journalRoot: root });
    await expect(store.applyRecordBatch([
      {
        learning: 'Bad self loop.',
        decision: { kind: 'create', title: 'Bad node', type: 'process', topic: 'journal-engine', tags: ['bad'], links: [{ type: 'relates', target: '9999' }], status: 'adopted', description: 'bad', context: 'ctx', consequences: '- bad' },
      },
    ])).rejects.toThrow(/dangling/i);

    const index = await readFile(join(root, 'index.md'), 'utf8');
    expect(index).not.toContain('| 0002 |');
    const nodes = await readFile(join(root, 'nodes', '0001-existing.md'), 'utf8');
    expect(nodes).toContain('Existing learning');
  });
});
