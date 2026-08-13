import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

const headers = (token: string) => ({ 'Content-Type': 'application/json', 'X-MMA-Client': 'claude-code', Authorization: `Bearer ${token}` });
const provenance = { actor_type: 'agent', actor_id: 'host-a', interface: 'ignored', initiated_by: 'host-a', authorized_by: 'host-a', timestamp: 'ignored', source: 'test' };
async function mutate(h: { baseUrl: string; token: string }, operation: string, input: object, expected_revision: number) {
  const response = await fetch(`${h.baseUrl}/initiatives`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ operation, input, expected_revision, provenance }) });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}
async function terminal(h: { baseUrl: string; token: string }, executionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${h.baseUrl}/execution/${executionId}`, { headers: headers(h.token) });
    if (response.status === 200) return await response.json() as Record<string, unknown>;
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('mock execution did not become terminal');
}

describe('Execution linkage integration', () => {
  it('records linked mock-provider work and replays an unconsumed outbox row after reopen', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd(), failLinkerOnceAfterTerminal: true });
    try {
      const product = await mutate(h, 'product_create', { name: 'MMA', slug: 'mma-linkage' }, 0);
      const initiative = await mutate(h, 'initiative_create', { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, 0);
      const task = await mutate(h, 'initiative_task_create', { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, 0);
      await mutate(h, 'initiative_task_claim', { uuid: task.uuid }, 0);
      const conflicted = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/a.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: task.uuid, authorized_by: 'host-b' } }) });
      expect(conflicted.status).toBe(400);
      expect(await conflicted.json()).toMatchObject({ error: { code: 'task_claim_conflict' } });
      expect(h.unconsumedOutbox()).toEqual([]);
      const dispatch = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(h.token), body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/a.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: task.uuid, authorized_by: 'host-a' } }) });
      expect(dispatch.status).toBe(202);
      const { executionId } = await dispatch.json() as { executionId: string };
      await terminal(h, executionId);
      expect(h.unconsumedOutbox()).toHaveLength(1);
      const restarted = await h.restart();
      try {
        const resume = await fetch(`${restarted.baseUrl}/initiatives`, { method: 'POST', headers: headers(restarted.token), body: JSON.stringify({ operation: 'initiative_resume', initiative: { uuid: initiative.uuid } }) });
        const record = await resume.json() as { tasks: Array<{ status: string; outcome: string | null; executionRefs: string[] }>; evidence: unknown[] };
        expect(record.tasks).toEqual([expect.objectContaining({ status: 'completed', outcome: 'succeeded_with_concerns', executionRefs: [executionId] })]);
        expect(record.evidence).toHaveLength(1);
        expect(restarted.unconsumedOutbox()).toEqual([]);
        const invalid = await fetch(`${restarted.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: headers(restarted.token), body: JSON.stringify({ type: 'review', target: { paths: ['/tmp/a.ts'] }, initiative: { initiative: { uuid: initiative.uuid }, task_uuid: task.uuid, authorized_by: 'host-a' } }) });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_task_transition' } });
        expect(restarted.unconsumedOutbox()).toEqual([]);
      } finally { await restarted.close(); }
    } finally { await h.close(); }
  });

  // SPEC-003 B6 defect 1 — `task_uuid` is optional (AC-1.1): Initiative-only linkage records
  // execution-result Evidence directly against the Initiative, with no Task registration or
  // Task transition (there is no Task).
  it('Initiative-only linkage (no task_uuid) records Evidence against the Initiative, with no Task involved', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd(), failLinkerOnceAfterTerminal: true });
    try {
      const product = await mutate(h, 'product_create', { name: 'MMA', slug: 'mma-init-only' }, 0);
      const initiative = await mutate(h, 'initiative_create', { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, 0);

      const dispatch = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: headers(h.token),
        body: JSON.stringify({
          type: 'review',
          target: { paths: ['/tmp/a.ts'] },
          initiative: { initiative: { uuid: initiative.uuid }, authorized_by: 'host-a' },
        }),
      });
      expect(dispatch.status).toBe(202);
      const { executionId } = await dispatch.json() as { executionId: string };
      await terminal(h, executionId);
      expect(h.unconsumedOutbox()).toHaveLength(1);

      const restarted = await h.restart();
      try {
        const resume = await fetch(`${restarted.baseUrl}/initiatives`, {
          method: 'POST', headers: headers(restarted.token),
          body: JSON.stringify({ operation: 'initiative_resume', initiative: { uuid: initiative.uuid } }),
        });
        const record = await resume.json() as {
          tasks: unknown[];
          evidence: Array<{ kind: string; locator: string }>;
        };
        // No Task was ever created — Initiative-only linkage never registers one.
        expect(record.tasks).toEqual([]);
        expect(record.evidence).toEqual([
          expect.objectContaining({ kind: 'execution_result', locator: `execution://${executionId}` }),
        ]);
        expect(restarted.unconsumedOutbox()).toEqual([]);
      } finally { await restarted.close(); }
    } finally { await h.close(); }
  });

  // SPEC-003 B6 defect 2 — the linker must record the commit-time SHA (persisted on the terminal
  // envelope), never a live `git rev-parse HEAD` read at replay time. Forces a replay AFTER a
  // later, unrelated commit lands in the same cwd and asserts the recorded Evidence still names
  // the ORIGINAL commit.
  it('a replay after a later commit still records the commit-time SHA, not live git HEAD', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mma-linkage-commitsha-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    writeFileSync(join(tmp, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: tmp });

    // The mock provider does no real filesystem work on its own — write the "implementer's" file
    // change from the prompt hook, so the engine's own commit has something to commit.
    const provider = mockProvider({ stage: 'ok', onPrompt: () => writeFileSync(join(tmp, 'work.txt'), 'work\n') });
    const h = await boot({ provider, cwd: tmp, failLinkerOnceAfterTerminal: true });
    try {
      const product = await mutate(h, 'product_create', { name: 'MMA', slug: 'mma-commitsha' }, 0);
      const initiative = await mutate(h, 'initiative_create', { product_id: product.uuid, title: 'I', goal: 'G', status: 'open', outcome: null }, 0);
      const task = await mutate(h, 'initiative_task_create', { initiative_id: initiative.uuid, title: 'T', goal: 'G', status: 'open', outcome: null, workspace_ids: [], resource_ids: [] }, 0);

      const dispatch = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(tmp)}`, {
        method: 'POST',
        headers: headers(h.token),
        body: JSON.stringify({
          type: 'delegate',
          prompt: 'do the work',
          reviewPolicy: 'none',
          initiative: { initiative: { uuid: initiative.uuid }, task_uuid: task.uuid, authorized_by: 'host-a' },
        }),
      });
      expect(dispatch.status).toBe(202);
      const { executionId } = await dispatch.json() as { executionId: string };
      await terminal(h, executionId);

      // The engine's own commit landed on top of the seed commit — this is the SHA the replay
      // must eventually record, no matter what HEAD looks like when replay actually runs.
      const shaAtCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
      expect(shaAtCommit).not.toBe('');

      // `failLinkerOnceAfterTerminal` made the first replay attempt fail — the row is still
      // unconsumed. Land a LATER, unrelated commit in the same cwd before replay retries.
      expect(h.unconsumedOutbox()).toHaveLength(1);
      writeFileSync(join(tmp, 'later.txt'), 'later, unrelated\n');
      execFileSync('git', ['add', '-A'], { cwd: tmp });
      execFileSync('git', ['commit', '-qm', 'later, unrelated'], { cwd: tmp });
      const shaAfterLaterCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
      expect(shaAfterLaterCommit).not.toBe(shaAtCommit);

      // Restart replays the outbox through a FRESH InitiativeLinker (no forced-failure hook) —
      // this is the "replay happens after a later commit" moment the defect describes. If the
      // linker read live git state it would record `shaAfterLaterCommit` instead.
      const restarted = await h.restart();
      try {
        const resume = await fetch(`${restarted.baseUrl}/initiatives`, {
          method: 'POST', headers: headers(restarted.token),
          body: JSON.stringify({ operation: 'initiative_resume', initiative: { uuid: initiative.uuid } }),
        });
        const record = await resume.json() as {
          evidence: Array<{ kind: string; locator: string; content_hash: string | null }>;
        };
        const commitEvidence = record.evidence.find((e) => e.kind === 'commit');
        expect(commitEvidence).toBeDefined();
        expect(commitEvidence!.locator).toBe(`commit://${shaAtCommit}`);
        expect(commitEvidence!.content_hash).toBe(shaAtCommit);
        expect(restarted.unconsumedOutbox()).toEqual([]);
      } finally { await restarted.close(); }
    } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
  });
});