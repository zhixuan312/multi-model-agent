import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  JournalIndexStore,
  searchCandidatesForRecall,
} from '../../packages/core/src/journal/adapters/journal-adapter.js';

// A recall payload is assembled from candidate PREVIEWS. Two properties must
// hold together, and the interesting failures are the ones where only one does:
//
//   1. The assembled payload is bounded, so a large corpus cannot push the
//      prompt past the model's input limit. (Pre-fix: unbounded.)
//   2. Nothing is dropped silently. When the budget binds, the caller learns
//      how many ranked candidates it did not see, so an answer can state its
//      own coverage instead of implying completeness.
//
// Property 2 is what makes this different from a top-K cap: a cap that drops
// relevant nodes without saying so trades correctness for size.

const BUDGET_BYTES = 120_000;

let root: string;

function writeNode(dir: string, id: string, descriptionLength: number): void {
  // A long `description` is the realistic bloat vector: frontmatter says
  // "one line" but nothing enforces it, and it is multiplied by candidate count.
  const description = 'config build test verify plan spec review data '.repeat(
    Math.ceil(descriptionLength / 47),
  ).slice(0, descriptionLength);
  const body = 'config build test verify plan spec review data model service handler route worker '.repeat(60);
  writeFileSync(
    path.join(dir, `${id}-node-${id}.md`),
    [
      '---',
      `id: "${id}"`,
      `title: "Node ${id} config build test verify plan spec review"`,
      'type: "decision"',
      // `topic` is required and validated; a node without one is rejected at
      // index time and never reaches retrieval at all.
      'topic: "test-corpus"',
      'status: "adopted"',
      'tags:',
      '  - config',
      '  - retrieval',
      'timestamp: "2026-01-06T00:00:00Z"',
      'links: []',
      'supersededBy: null',
      'source: "Execute"',
      `description: "${description}"`,
      '---',
      '',
      body,
    ].join('\n'),
    'utf8',
  );
}

describe('journal recall: preview budget', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mma-recall-budget-'));
    const nodes = path.join(root, '.mma', 'journal', 'nodes');
    mkdirSync(nodes, { recursive: true });
    // 400 nodes each carrying a ~2KB description. Unbounded, the assembled
    // previews would run to roughly 900KB — far past any model's input limit.
    for (let i = 1; i <= 400; i++) writeNode(nodes, String(i).padStart(4, '0'), 2000);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('bounds the assembled payload and reports what it withheld', async () => {
    const store = await JournalIndexStore.open({ journalRoot: path.join(root, '.mma', 'journal') });
    try {
      // Every token here appears in the fixture's indexed fields. Matching is
      // conjunctive, so a token absent from the corpus would return nothing and
      // the budget assertions below would pass vacuously.
      const result = await searchCandidatesForRecall(store, {
        prompt: 'config build test verify plan spec review data',
        includeHistory: false,
      });

      expect(result.candidates.length).toBeGreaterThan(0);

      const bytes = JSON.stringify(result.candidates).length;
      expect(bytes, `assembled previews were ${bytes} bytes`).toBeLessThanOrEqual(BUDGET_BYTES);

      // Accounting must balance: every ranked candidate is either kept or counted.
      expect(result.candidates.length + result.withheld).toBe(result.totalRanked);

      // When the budget binds, the drop is visible. When it does not, withheld is 0.
      if (result.candidates.length < result.totalRanked) {
        expect(result.withheld).toBeGreaterThan(0);
      } else {
        expect(result.withheld).toBe(0);
      }
    } finally {
      store.close();
    }
  });

  it('bounds each preview description so one node cannot dominate the payload', async () => {
    const store = await JournalIndexStore.open({ journalRoot: path.join(root, '.mma', 'journal') });
    try {
      const result = await searchCandidatesForRecall(store, {
        prompt: 'config build test verify plan spec review',
        includeHistory: false,
      });
      expect(result.candidates.length).toBeGreaterThan(0);
      for (const candidate of result.candidates) {
        // 300 chars + the single-character ellipsis marking the cut.
        expect(candidate.description.length).toBeLessThanOrEqual(301);
      }
    } finally {
      store.close();
    }
  });

  it('keeps the highest-ranked candidate even when it alone exceeds the budget', async () => {
    // A single oversized node must degrade to one candidate, never to none —
    // an empty answer is worse than a large one.
    const solo = mkdtempSync(path.join(tmpdir(), 'mma-recall-solo-'));
    try {
      const nodes = path.join(solo, '.mma', 'journal', 'nodes');
      mkdirSync(nodes, { recursive: true });
      writeNode(nodes, '0001', 200_000);
      const store = await JournalIndexStore.open({ journalRoot: path.join(solo, '.mma', 'journal') });
      try {
        const result = await searchCandidatesForRecall(store, {
          prompt: 'config build test verify plan spec review',
          includeHistory: false,
        });
        expect(result.candidates.length).toBeGreaterThanOrEqual(1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });
});
