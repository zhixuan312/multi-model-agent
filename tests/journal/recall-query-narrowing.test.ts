import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  JournalIndexStore,
  searchCandidatesForRecall,
} from '../../packages/core/src/journal/adapters/journal-adapter.js';

// Query narrowing keeps a rarest-first PREFIX of a query's tokens so the FTS
// match set stays bounded as the corpus grows. Document frequency is the
// rarity measure, which puts a token appearing in ZERO documents at the very
// front — rarer than any real term.
//
// That is the trap. A zero-frequency token contributes nothing to an OR match,
// but it still occupies a slot in the kept prefix, and the running total it
// leaves at 0 means the next real token is measured against the ceiling alone.
// A question phrased in ordinary English ("tell me about X") therefore spends
// its prefix on words the corpus has never seen and drops the one word that
// would have matched — returning nothing at all.
//
// The failure scales with the corpus: the more documents a real token appears
// in, the more certainly it trips the ceiling and is dropped.

let root: string;

function writeNode(dir: string, id: string, subject: string): void {
  writeFileSync(
    path.join(dir, `${id}-n.md`),
    [
      '---',
      `id: "${id}"`,
      `title: "Node ${id} ${subject} routing spec verify"`,
      'type: "decision"',
      'topic: "test-corpus"',
      'status: "adopted"',
      `description: "${subject} routing spec verify config build review"`,
      'timestamp: "2026-01-06T00:00:00Z"',
      'tags:',
      '  - retrieval',
      'links: []',
      'supersededBy: null',
      'source: "Execute"',
      '---',
      '',
      `${subject} routing spec verify config build review data model service`,
    ].join('\n'),
    'utf8',
  );
}

describe('journal recall: query narrowing', () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mma-recall-narrow-'));
    const nodes = path.join(root, '.mma', 'journal', 'nodes');
    mkdirSync(nodes, { recursive: true });
    // Every node carries the subject term, so its document frequency is high
    // enough to exceed the narrowing ceiling on its own — the condition under
    // which the bug bites. This is what a real corpus looks like at scale.
    for (let i = 1; i <= 400; i++) writeNode(nodes, String(i).padStart(4, '0'), 'claims');
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function ranked(prompt: string): Promise<number> {
    const store = await JournalIndexStore.open({ journalRoot: path.join(root, '.mma', 'journal') });
    try {
      const result = await searchCandidatesForRecall(store, { prompt, includeHistory: false });
      return result.totalRanked;
    } finally {
      store.close();
    }
  }

  it('matches on a bare subject term', async () => {
    expect(await ranked('claims')).toBeGreaterThan(0);
  });

  it('does not lose the match when the question is phrased in English', async () => {
    // Same information need as the bare term, plus words the corpus has never
    // seen. The result must not be worse than the bare term's.
    expect(await ranked('tell me all about claims and what is impacted')).toBeGreaterThan(0);
  });

  it('a single absent word cannot cancel a matching one', async () => {
    // The minimal reproduction: one zero-frequency token beside one real token.
    expect(await ranked('tell claims')).toBeGreaterThan(0);
  });

  it('returns nothing only when nothing in the query matches', async () => {
    // The one case where an empty result is the correct answer.
    expect(await ranked('tell me about xylophones and quokkas')).toBe(0);
  });
});
