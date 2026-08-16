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

/** Same node, with a description built from 3-byte-per-character text. */
function writeMultibyteNode(dir: string, id: string, descriptionLength: number): void {
  // Each of these characters is one UTF-16 code unit and THREE UTF-8 bytes, so a payload
  // measured with `.length` reads at a third of its real size.
  const description = '設定 構築 検証 計画 仕様 確認 資料 '.repeat(Math.ceil(descriptionLength / 24)).slice(0, descriptionLength);
  writeFileSync(
    path.join(dir, `${id}-node-${id}.md`),
    [
      '---', `id: "${id}"`, `title: "Node ${id} config build test verify plan spec review"`,
      'type: "decision"', 'topic: "test-corpus"', 'status: "adopted"',
      'tags:', '  - config', '  - retrieval',
      'timestamp: "2026-01-06T00:00:00Z"', 'links: []', 'supersededBy: null', 'source: "Execute"',
      `description: "${description}"`, '---', '',
      'config build test verify plan spec review data model service handler route worker '.repeat(60),
    ].join('\n'),
    'utf8',
  );
}

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

      // `Buffer.byteLength`, not `.length`. This assertion called its own value "bytes" while
      // counting UTF-16 code units — the same slip the implementation had, so an ASCII fixture
      // could not tell them apart and the test agreed with the bug.
      const bytes = Buffer.byteLength(JSON.stringify(result.candidates), 'utf8');
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

  /**
   * The budget is named in BYTES and bounds what reaches a worker's prompt.
   *
   * `applyPreviewBudget` measured each candidate with `JSON.stringify(candidate).length` —
   * UTF-16 code units. For ASCII the two agree, which is every fixture above, so the slip was
   * invisible. A journal written in Japanese (or with accented words, or emoji) measured at a
   * third of its real size and the assembled payload could overshoot 120 KB by ~3x — the exact
   * ceiling this budget exists to hold.
   */
  it('holds the byte budget for a corpus that is not ASCII', async () => {
    const mbRoot = mkdtempSync(path.join(tmpdir(), 'mma-recall-budget-mb-'));
    try {
      const nodes = path.join(mbRoot, '.mma', 'journal', 'nodes');
      mkdirSync(nodes, { recursive: true });
      for (let i = 1; i <= 400; i++) writeMultibyteNode(nodes, String(i).padStart(4, '0'), 2000);

      const store = await JournalIndexStore.open({ journalRoot: path.join(mbRoot, '.mma', 'journal') });
      try {
        const result = await searchCandidatesForRecall(store, {
          prompt: 'config build test verify plan spec review data',
          includeHistory: false,
        });
        expect(result.candidates.length).toBeGreaterThan(0);

        const bytes = Buffer.byteLength(JSON.stringify(result.candidates), 'utf8');
        expect(bytes, `assembled previews were ${bytes} bytes, over a ${BUDGET_BYTES}-byte budget`)
          .toBeLessThanOrEqual(BUDGET_BYTES);
      } finally {
        store.close();
      }
    } finally {
      rmSync(mbRoot, { recursive: true, force: true });
    }
  }, 60_000);
});