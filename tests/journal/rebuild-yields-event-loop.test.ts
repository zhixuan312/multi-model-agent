import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JournalIndexStore } from '../../packages/core/src/journal/adapters/journal-adapter.js';

// `node:sqlite` is synchronous. An index rebuild's write loop therefore holds
// the event loop for exactly as long as it runs, and nothing else in the
// process — including the daemon's health endpoint — is served during it.
//
// Measured on a 5000-node corpus, an unbroken loop blocked for 3.8 SECONDS in
// one contiguous region. A caller does not experience that as a slow daemon;
// it experiences a dead one.
//
// The invariant this pins is not "rebuilding is fast" — rebuilding a large
// corpus is legitimately slow. It is "no single block is long enough to look
// like a hang". The ceiling below is deliberately loose: it is far above the
// ~75ms a batch costs on this machine and far below the 1500ms at which the
// release smoke calls the daemon stalled, so it fails on a REGRESSION (a
// return to one unbroken loop) rather than on a slow CI runner.

// Sized from measurement, not taste. Max event-loop block during a rebuild of
// this fixture, on the development machine:
//
//   nodes   without yields   with yields
//   1200         67ms             5ms
//   3000        520ms            18ms
//
// 1200 does not discriminate — an unbroken loop still finishes inside any
// ceiling loose enough to survive a slow runner, so the test would pass on the
// bug. 3000 separates by 29x, which is margin a loaded CI box cannot close.
const NODES = 3000;
// Between the two measurements, and an order of magnitude below the 1500ms at
// which the release smoke declares the daemon stalled. Fails on a return to one
// unbroken loop; does not fail on a slow machine.
const MAX_ACCEPTABLE_BLOCK_MS = 200;

let root: string;

describe('journal index rebuild: event-loop responsiveness', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mma-rebuild-yield-'));
    const nodes = path.join(root, '.mma', 'journal', 'nodes');
    mkdirSync(nodes, { recursive: true });
    const body = 'claims routing spec verify config build review data model service '.repeat(60);
    for (let i = 1; i <= NODES; i++) {
      const id = String(i).padStart(4, '0');
      writeFileSync(path.join(nodes, `${id}-n.md`), [
        '---',
        `id: "${id}"`,
        `title: "Node ${id} claims routing spec verify"`,
        'type: "decision"',
        'topic: "test-corpus"',
        'status: "adopted"',
        'tags:',
        '  - retrieval',
        'timestamp: "2026-01-06T00:00:00Z"',
        'links: []',
        'supersededBy: null',
        'source: "Execute"',
        'description: "claims routing spec verify config build review"',
        '---',
        '',
        body,
      ].join('\n'), 'utf8');
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('never blocks the event loop for a single long stretch while rebuilding', async () => {
    const lags: number[] = [];
    let last = Date.now();
    const probe = setInterval(() => {
      const now = Date.now();
      lags.push(now - last - 50);
      last = now;
    }, 50);

    // Discard startup noise so it is not mistaken for a stall.
    await new Promise((resolve) => setTimeout(resolve, 150));
    lags.length = 0;
    last = Date.now();

    const store = await JournalIndexStore.open({ journalRoot: path.join(root, '.mma', 'journal') });
    let indexed = 0;
    try {
      await store.ensureHealthy();
      // `ensureHealthy` only creates the schema. `ensureFresh` is what reads
      // the corpus and writes the rows — the loop this test exists to measure.
      // Measuring the wrong call would pass on an empty index and prove
      // nothing at all.
      await store.ensureFresh();
      indexed = store.allDocumentsMeta().length;
      // A tick delayed by a final block can only be recorded once the loop is
      // free again; clearing the probe immediately would hide the worst case.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      clearInterval(probe);
      store.close();
    }

    // Guard against a vacuous pass: an empty rebuild blocks nobody.
    expect(indexed, 'the rebuild indexed nothing, so it measured nothing').toBe(NODES);
    expect(lags.length, 'the probe never ran; the measurement proves nothing').toBeGreaterThan(3);
    const worst = Math.max(...lags);
    expect(
      worst,
      `the rebuild blocked the event loop for ${worst}ms in one stretch — the write loop must yield between batches`,
    ).toBeLessThan(MAX_ACCEPTABLE_BLOCK_MS);
  });

  it('still indexes every node', async () => {
    const store = await JournalIndexStore.open({ journalRoot: path.join(root, '.mma', 'journal') });
    try {
      await store.ensureHealthy();
      await store.ensureFresh();
      // Yielding mid-transaction must not cost rows: the transaction stays open
      // across each yield and commits once, so the corpus is all-or-nothing.
      expect(store.allDocumentsMeta().length).toBe(NODES);
      const matched = store.candidateDocumentsMeta({
        tokens: ['claims'], topic: undefined, includeHistory: true, limit: NODES * 2,
      });
      expect(matched.length).toBe(NODES);
    } finally {
      store.close();
    }
  });
});
