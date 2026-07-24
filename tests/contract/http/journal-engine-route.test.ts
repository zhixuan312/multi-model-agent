import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';

const HEADERS = (token: string) => ({
  'Content-Type': 'application/json',
  'X-MMA-Main-Model': 'claude-opus-4-8',
  'X-MMA-Client': 'claude-code',
  Authorization: `Bearer ${token}`,
});

async function postTaskCwd(h: { baseUrl: string; token: string }, cwd: string, body: object) {
  const res = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(cwd)}`, {
    method: 'POST',
    headers: HEADERS(h.token),
    body: JSON.stringify(body),
  });
  const receipt = await res.json() as { taskId: string };
  for (let i = 0; i < 100; i += 1) {
    const poll = await fetch(`${h.baseUrl}/task/${receipt.taskId}`, { headers: HEADERS(h.token) });
    if (poll.status === 200) return poll.json() as Promise<Record<string, unknown>>;
  }
  throw new Error('timed out');
}

async function postTask(h: { baseUrl: string; token: string }, body: object) {
  return postTaskCwd(h, process.cwd(), body);
}

describe('journal engine routes', () => {
  it('skips reviewer when invariants pass and caller omitted reviewPolicy', async () => {
    let opened = 0;
    const provider = mockProvider({
      sequence: [{ output: JSON.stringify([{ learning: 'A', decision: { kind: 'merge', targetNodeId: '0001', reason: 'covered' } }]) }],
      onOpen: () => { opened += 1; },
    });
    const h = await boot({ provider, cwd: process.cwd() });
    try {
      const env = await postTask(h, { type: 'journal_record', records: [{ prompt: 'A', topic: 'journal-engine' }] });
      expect((env.task as { status: string }).status).toBe('done');
      expect(opened).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('still forces reviewer when caller explicitly sets reviewPolicy=reviewed', async () => {
    let opened = 0;
    const provider = mockProvider({
      sequence: [
        { output: JSON.stringify([{ learning: 'A', decision: { kind: 'merge', targetNodeId: '0001', reason: 'covered' } }]) },
        { output: JSON.stringify({ recorded: [{ learning: 'A', type: 'process', topic: 'journal-engine', nodeId: '0001', nodePath: '.mma/journal/nodes/0001-existing.md' }], failed: [] }) },
      ],
      onOpen: () => { opened += 1; },
    });
    const h = await boot({ provider, cwd: process.cwd() });
    try {
      await postTask(h, { type: 'journal_record', reviewPolicy: 'reviewed', records: [{ prompt: 'A', topic: 'journal-engine' }] });
      expect(opened).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('does not crash the task when the implementer emits malformed decision output', async () => {
    const provider = mockProvider({
      sequence: [
        // Implementer: non-JSON garbage → parseRecordDecisions throws.
        { output: 'this is not valid decision json at all' },
        // Reviewer (invariants failed → reviewer still runs) — shape is irrelevant to the assertion.
        { output: JSON.stringify({ recorded: [], failed: [{ learning: 'A', reason: 'parse error' }] }) },
      ],
    });
    const h = await boot({ provider, cwd: process.cwd() });
    try {
      const env = await postTask(h, {
        type: 'journal_record',
        records: [{ prompt: 'A', topic: 'journal-engine' }, { prompt: 'B', topic: 'journal-engine' }],
      });
      // Task completes with the documented per-record shape, not a crashed task.
      expect((env.task as { status: string }).status).not.toBe('failed');
      expect(env.error).toBeNull();
      const applied = JSON.parse((env.raw as { implementer: string }).implementer) as {
        recorded: unknown[]; failed: Array<{ learning: string; reason: string }>;
      };
      expect(applied.recorded).toEqual([]);
      expect(applied.failed).toHaveLength(2);
      expect(applied.failed.map((entry) => entry.learning).sort()).toEqual(['A', 'B']);
      expect(applied.failed.every((entry) => entry.reason.length > 0)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('records the first node against a fresh cwd with no .mma/journal (no ENOENT crash)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mma-fresh-record-'));
    const decision = JSON.stringify([{
      learning: 'First learning',
      decision: {
        kind: 'create', title: 'First', type: 'process', topic: 'journal-engine',
        tags: ['first'], links: [], status: 'adopted', description: 'first', context: 'ctx', consequences: '- c',
      },
    }]);
    const provider = mockProvider({ sequence: [{ output: decision }] });
    const h = await boot({ provider, cwd });
    try {
      const env = await postTaskCwd(h, cwd, { type: 'journal_record', records: [{ prompt: 'First learning', topic: 'journal-engine' }] });
      expect((env.task as { status: string }).status).toBe('done');
      expect(env.error).toBeNull();
      const nodes = await readdir(join(cwd, '.mma', 'journal', 'nodes'));
      expect(nodes.some((file) => file.startsWith('0001-'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('recalls against a fresh cwd with no .mma/journal (empty corpus, no crash)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'mma-fresh-recall-'));
    const provider = mockProvider({
      sequence: [{ output: JSON.stringify({ answer: 'Nothing recorded yet.', criteriaCovered: ['keyword-match'], findings: [] }) }],
    });
    const h = await boot({ provider, cwd });
    try {
      const env = await postTaskCwd(h, cwd, { type: 'journal_recall', prompt: 'anything at all', reviewPolicy: 'none' });
      expect((env.task as { status: string }).status).not.toBe('failed');
      expect(env.error).toBeNull();
      expect((env.execution as { worktree: unknown }).worktree).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('keeps journal routes worktree-free and accepts includeHistory without outbound network dependency', async () => {
    const provider = mockProvider({
      sequence: [{ output: JSON.stringify({ answer: 'A', criteriaCovered: ['process'], findings: [] }) }],
    });
    const h = await boot({ provider, cwd: process.cwd() });
    try {
      const env = await postTask(h, { type: 'journal_recall', prompt: 'What did we learn about indexing?', includeHistory: true });
      expect((env.execution as { worktree: unknown }).worktree).toBeNull();
      expect(env.error).toBeNull();
    } finally {
      await h.close();
    }
  });
});
