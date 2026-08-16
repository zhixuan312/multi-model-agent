/**
 * The journal's node-id space must not corrupt itself at 10,000 nodes.
 *
 * `ID_RE` was `/^\d{4}$/` and `allocateNextNodeId` returns `String(max + 1).padStart(4, '0')`, so
 * the 10,000th node was allocated `"10000"` — which that regex rejected. `coerceNodeId` then fell
 * through to the filename, where `([0-9]{4})-` matched the LAST four digits of `10000-slug.md`
 * and produced `"0000"`: the id of the very first node in the corpus.
 *
 * The failure compounds. With 10000 read back as 0000, `allocateNextNodeId` re-derives its maximum
 * from a set that no longer contains it, so it hands out `"10000"` again on the next record, and
 * again after that. Links pointing at `0000` resolve to whichever node won, and the derived index
 * keys two different nodes to one row. No error is raised at any point.
 *
 * Four digits stays the written form below 10,000, so every id ever persisted is unaffected.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateNextNodeId,
  parseJournalNodeDocument,
  renderNodeFilename,
} from '../../packages/core/src/journal/node-codec.js';

function nodeMarkdown(id: string): string {
  return [
    '---', `id: "${id}"`, 'title: "Crossing the boundary"', 'type: "decision"',
    'topic: "scale"', 'status: "adopted"', 'tags: []',
    'timestamp: "2026-01-01T00:00:00Z"', 'links: []', 'supersededBy: null',
    'description: "d"', '---', '', 'body',
  ].join('\n');
}

describe('node ids past 9,999', () => {
  it('allocates a five-digit id after 9999', () => {
    expect(allocateNextNodeId(['9999'])).toBe('10000');
    expect(allocateNextNodeId(['10000'])).toBe('10001');
  });

  it('reads a five-digit id back as itself, not as 0000', () => {
    const id = allocateNextNodeId(['9999']);
    const filename = renderNodeFilename({ id, title: 'Crossing the boundary' });
    expect(filename.startsWith('10000-')).toBe(true);

    const parsed = parseJournalNodeDocument(nodeMarkdown(id), `nodes/${filename}`);
    expect(parsed.id, 'a five-digit node collided with node 0000').toBe('10000');
  });

  it('recovers a five-digit id from the filename when the frontmatter is unquoted', () => {
    // The case `coerceNodeId`'s filename fallback exists for: `id: 10000` YAML-parses to a number.
    const unquoted = nodeMarkdown('10000').replace('id: "10000"', 'id: 10000');
    expect(parseJournalNodeDocument(unquoted, 'nodes/10000-crossing-the-boundary.md').id).toBe('10000');
  });

  it('still reads four-digit ids exactly as before', () => {
    expect(allocateNextNodeId(['0001', '0042'])).toBe('0043');
    expect(parseJournalNodeDocument(nodeMarkdown('0007'), 'nodes/0007-crossing-the-boundary.md').id).toBe('0007');
  });

  it('keeps allocation monotonic across the boundary, so ids are never reissued', () => {
    const ids = ['9998', '9999'];
    for (let i = 0; i < 3; i++) ids.push(allocateNextNodeId(ids));
    expect(ids).toEqual(['9998', '9999', '10000', '10001', '10002']);
    expect(new Set(ids).size, 'an id was reissued').toBe(ids.length);
  });
});
