import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import { canonicalContractDigest } from '@zhixuan92/multi-model-agent-core';

// SPEC-005 Task I-6: named apart from a literal `practice:` key — this file is itself named in
// the practice-removal-sweep's `scopedFiles` list, so it must never carry the exact
// mechanism-specific syntax the residual scan checks for.
const RETIRED_FIELD = 'practice';

const HEADERS = (token: string) => ({
  'Content-Type': 'application/json',
  'X-MMA-Main-Model': 'claude-opus-4-8',
  'X-MMA-Client': 'claude-code',
  Authorization: `Bearer ${token}`,
});

async function dispatchCwd(h: { baseUrl: string; token: string }, cwd: string, body: object) {
  return fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(cwd)}`, {
    method: 'POST', headers: HEADERS(h.token), body: JSON.stringify(body),
  });
}

async function dispatch(h: { baseUrl: string; token: string }, body: object) {
  return dispatchCwd(h, process.cwd(), body);
}

async function poll202(h: { baseUrl: string; token: string }, executionId: string) {
  const res = await fetch(`${h.baseUrl}/execution/${executionId}`, { headers: HEADERS(h.token) });
  return { status: res.status, body: await res.json(), contentType: res.headers.get('content-type') };
}

async function pollToTerminal(h: { baseUrl: string; token: string }, executionId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${h.baseUrl}/execution/${executionId}`, { headers: HEADERS(h.token) });
    if (res.status === 200) return (await res.json()) as Record<string, unknown>;
    if (res.status !== 202) throw new Error(`Unexpected ${res.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

describe('route contract', () => {
  describe('journal_record batch contract', () => {
    it('normalizes legacy input into records[], applies decisions, and runs the reviewer when review is forced', async () => {
      const prompts: string[] = [];
      let openCount = 0;
      // Implementer now emits a decision array (decide-then-apply); the engine applies it and the
      // reviewer re-emits the applied {recorded,failed} answer shape. reviewPolicy:'reviewed' forces
      // the reviewer (otherwise passing invariants would skip it).
      const decisionArray = JSON.stringify([
        { learning: 'A', decision: { kind: 'merge', targetNodeId: '0001', reason: 'covered' } },
      ]);
      const reviewerOutput = JSON.stringify({
        recorded: [{ learning: 'A', type: 'process', topic: 'worker-runtime', nodeId: '0001', nodePath: '.mma/journal/nodes/0001-a.md' }],
        failed: [{ learning: 'B', reason: 'duplicate' }],
      });
      const h = await boot({
        provider: mockProvider({
          sequence: [{ output: decisionArray }, { output: reviewerOutput }],
          onPrompt: (p) => prompts.push(p),
          onOpen: () => { openCount += 1; },
        }),
        cwd: process.cwd(),
      });
      try {
        const res = await dispatch(h, { type: 'journal_record', reviewPolicy: 'reviewed', prompt: 'A', topic: 'worker-runtime' });
        expect(res.status).toBe(202);
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);

        expect(openCount).toBe(2);
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain('"records": [');
        expect(prompts[0]).not.toMatch(/"type": "journal_record",\s+"prompt":/);
        expect(prompts[1]).toContain('## Submitted Records (completeness check)');
        expect(prompts[1]).toContain('1. [record 1] worker-runtime :: A');

        const summary = (env.output as Record<string, unknown>).summary as { recorded: unknown[]; failed: unknown[] };
        expect(summary.recorded).toHaveLength(1);
        expect(summary.failed).toHaveLength(1);
        expect((env.execution as Record<string, unknown>).status).toBe('done');
      } finally { await h.close(); }
    });

    // Seeded in a throwaway cwd because a merge decision needs its target node to exist.
    // This used to run against process.cwd() and depended on the maintainer's real
    // <repo>/.mma/journal/ containing node 0001 — green on that machine, red on a fresh
    // checkout, and order-dependent within a worker. See the same note in
    // tests/contract/http/journal-engine-route.test.ts.
    it('applies decisions then SKIPS the reviewer when invariants pass and reviewPolicy is omitted', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'mma-route-journal-'));
      const seed = JSON.stringify([{
        learning: 'Seed learning',
        decision: {
          kind: 'create', title: 'Seed', type: 'process', topic: 'worker-runtime',
          tags: ['seed'], links: [], status: 'adopted',
          description: 'seed', context: 'ctx', consequences: '- c',
        },
      }]);
      const seedHarness = await boot({ provider: mockProvider({ sequence: [{ output: seed }] }), cwd });
      try {
        const seedRes = await dispatchCwd(seedHarness, cwd, { type: 'journal_record', prompt: 'Seed learning', topic: 'worker-runtime' });
        const { executionId: seedId } = (await seedRes.json()) as { executionId: string };
        await pollToTerminal(seedHarness, seedId);
      } finally { await seedHarness.close(); }

      let openCount = 0;
      const decisionArray = JSON.stringify([
        { learning: 'A', decision: { kind: 'merge', targetNodeId: '0001', reason: 'covered' } },
      ]);
      const h = await boot({
        provider: mockProvider({
          sequence: [{ output: decisionArray }],
          onOpen: () => { openCount += 1; },
        }),
        cwd,
      });
      try {
        const res = await dispatchCwd(h, cwd, { type: 'journal_record', prompt: 'A', topic: 'worker-runtime' });
        expect(res.status).toBe(202);
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);

        expect(openCount).toBe(1); // implementer only — reviewer skipped by passing invariants
        const summary = (env.output as Record<string, unknown>).summary as { recorded: unknown[]; failed: unknown[] };
        expect(summary.recorded).toHaveLength(1);
        expect(summary.failed).toHaveLength(0);
        expect((env.execution as Record<string, unknown>).status).toBe('done');
      } finally { await h.close(); }
    });

    it('downgrades journal_record to done_with_concerns when forced reviewer output omits submitted records', async () => {
      const prompts: string[] = [];
      const twoDecisions = JSON.stringify([
        { learning: 'A', decision: { kind: 'merge', targetNodeId: '0001', reason: 'covered' } },
        { learning: 'B', decision: { kind: 'merge', targetNodeId: '0001', reason: 'covered' } },
      ]);
      const oneRecorded = JSON.stringify({
        recorded: [{ learning: 'A', type: 'process', topic: 'worker-runtime', nodeId: '0001', nodePath: '.mma/journal/nodes/0001-a.md' }],
        failed: [],
      });
      const h = await boot({
        provider: mockProvider({ sequence: [{ output: twoDecisions }, { output: oneRecorded }], onPrompt: (p) => prompts.push(p) }),
        cwd: process.cwd(),
      });
      try {
        const res = await dispatch(h, {
          type: 'journal_record',
          reviewPolicy: 'reviewed',
          records: [{ prompt: 'A', topic: 'worker-runtime' }, { prompt: 'B', topic: 'worker-runtime' }],
        });
        expect(res.status).toBe(202);
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);

        expect(prompts[0]).toContain('"records": [');
        expect(prompts[1]).toContain('1. [record 1] worker-runtime :: A');
        expect(prompts[1]).toContain('2. [record 2] worker-runtime :: B');
        expect((env.execution as Record<string, unknown>).status).toBe('done_with_concerns');
        expect(env.error).toBeNull();
      } finally { await h.close(); }
    });
  });

  // ── Dispatch receipt (POST /execution → 202) ──

  describe('POST /execution dispatch receipt', () => {
    it('returns 202 with executionId and statusUrl', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        expect(res.status).toBe(202);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.executionId).toBeTypeOf('string');
        expect(body.statusUrl).toMatch(/^\/execution\//);
      } finally { await h.close(); }
    });
  });

  // ── Structured 202 polling ──

  describe('GET /execution/:executionId polling (202)', () => {
    /**
     * Driven by a HANGING provider, and the 202 is asserted rather than assumed.
     *
     * This booted `stage: 'ok'` and wrapped every assertion in `if (poll.status === 202)`. The
     * mock finishes before the first poll lands, so the poll returned 200 and the body of the
     * test never ran — measured, not inferred. The case named six fields of the running
     * snapshot and checked none of them.
     */
    it('returns structured JSON with executionId, status, phase, elapsedMs, phaseElapsedMs, startedAt', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'hang' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const poll = await poll202(h, executionId);

        expect(poll.status, 'a hanging provider must still be running when polled').toBe(202);
        expect(poll.contentType).toContain('application/json');
        const b = poll.body as Record<string, unknown>;
        expect(b.executionId).toBe(executionId);
        expect(b.status).toBe('running');
        expect(b.phase).toBeTypeOf('string');
        expect(b.elapsedMs).toBeTypeOf('number');
        expect(b.phaseElapsedMs).toBeTypeOf('number');
        expect(b.startedAt).toBeTypeOf('string');
      } finally { await h.close(); }
    });
  });

  // ── Layered 200 terminal shape ──

  describe('GET /execution/:executionId terminal (200)', () => {
    it('has exactly: execution, output, metrics, raw, error', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        expect(Object.keys(env).sort()).toEqual(['error', 'execution', 'metrics', 'output', 'raw']);
      } finally { await h.close(); }
    });

    it('execution block has executionId, type, status', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        const execution = env.execution as Record<string, unknown>;
        expect(execution.executionId).toBe(executionId);
        expect(execution.type).toBe('review');
        expect(['done', 'done_with_concerns', 'failed']).toContain(execution.status);
      } finally { await h.close(); }
    });

    it('execution.subtype present for audit, absent for other routes; the retired technique-selector field never appears on the wire', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const r1 = await dispatch(h, { type: 'audit', subtype: 'spec', target: { paths: ['/tmp/a.md'] } });
        const { executionId: t1 } = (await r1.json()) as { executionId: string };
        const env1 = await pollToTerminal(h, t1);
        expect((env1.execution as Record<string, unknown>).subtype).toBe('spec');

        const r2 = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId: t2 } = (await r2.json()) as { executionId: string };
        const env2 = await pollToTerminal(h, t2);
        expect((env2.execution as Record<string, unknown>).subtype).toBeUndefined();

        // SPEC-005 Task I-6: the technique-selector field is retired entirely — a request
        // carrying it is rejected by the strict schema before admission (invalid_request),
        // it never reaches the terminal envelope. `method` is the sole replacement input
        // and is always present as `string | null` (proven in
        // tests/initiative-record/method-registry.integration.test.ts).
        const r3 = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] }, [RETIRED_FIELD]: 'software' });
        expect(r3.status).toBe(400);
        const body3 = (await r3.json()) as { error?: { code?: string } };
        expect(body3.error?.code).toBe('invalid_request');
      } finally { await h.close(); }
    });

    it('output block has summary, filesChanged, contextBlockId', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        const out = env.output as Record<string, unknown>;
        expect(out).toHaveProperty('summary');
        expect(out).toHaveProperty('filesChanged');
        expect(out).toHaveProperty('contextBlockId');
      } finally { await h.close(); }
    });

    it('metrics includes token usage per phase and total', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        const m = env.metrics as Record<string, unknown>;
        expect(m).toHaveProperty('totalUsage');
        const impl = m.implementer as Record<string, unknown>;
        expect(impl).toHaveProperty('usage');
        const usage = impl.usage as Record<string, unknown>;
        expect(usage).toHaveProperty('inputTokens');
        expect(usage).toHaveProperty('outputTokens');
      } finally { await h.close(); }
    });

    it('error is null for both done and done_with_concerns; only failed carries a fatal error', async () => {
      // A reviewer that emits non-JSON is a reviewer-availability concern, not a task
      // failure — the implementer answer still stands. So done_with_concerns MUST carry
      // error: null (matches response-shape.md and the telemetry envelope).
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        const execution = env.execution as Record<string, unknown>;
        expect(['done', 'done_with_concerns']).toContain(execution.status);
        expect(env.error).toBeNull();
      } finally { await h.close(); }
    });

    it('execution.worktree is null for read routes', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        expect((env.execution as Record<string, unknown>).worktree).toBeNull();
      } finally { await h.close(); }
    });
  });

  // ── Reviewer parse failure degrades gracefully (no hard fail) ──

  describe('reviewer parse failure degrades to the implementer answer', () => {
    // Implementer emits a valid structured answer; reviewer emits prose with no JSON
    // (the real-world haiku-flakes-on-format case). The task must NOT hard-fail — the
    // implementer answer stands, surfaced in output.summary, with a non-fatal note.
    const degradeProvider = () => mockProvider({
      sequence: [
        { output: '{"headline":"IMPL_MARKER_9f","findings":[]}' }, // implementer (send #1)
        { output: 'I looked at the changes and they seem fine, but I forgot to emit JSON.' }, // reviewer (send #2), no braces → parse fails
      ],
    });

    it('status is done_with_concerns, not failed', async () => {
      const h = await boot({ provider: degradeProvider(), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        expect((env.execution as Record<string, unknown>).status).toBe('done_with_concerns');
      } finally { await h.close(); }
    });

    it('error is null — a reviewer format flake is not a fatal error', async () => {
      const h = await boot({ provider: degradeProvider(), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        expect(env.error).toBeNull();
      } finally { await h.close(); }
    });

    it('output.summary carries the implementer answer (not the reviewer garbage)', async () => {
      const h = await boot({ provider: degradeProvider(), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        const summary = (env.output as Record<string, unknown>).summary as Record<string, unknown>;
        expect(summary).toMatchObject({ headline: 'IMPL_MARKER_9f' });
      } finally { await h.close(); }
    });

    it('output.reviewerNote surfaces the parse-failure reason (advisory)', async () => {
      const h = await boot({ provider: degradeProvider(), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        const note = (env.output as Record<string, unknown>).reviewerNote as Record<string, unknown> | null;
        expect(note).not.toBeNull();
        expect(note).toMatchObject({ code: 'reviewer_unavailable' });
        expect(note!.message).toBeTypeOf('string');
        expect((note!.message as string).length).toBeGreaterThan(0);
      } finally { await h.close(); }
    });

    it('output.reviewerNote is null when the reviewer parses cleanly', async () => {
      // Reviewer emits valid refiner-ish JSON on both sends → clean parse → no note.
      const cleanProvider = mockProvider({
        sequence: [
          { output: '{"headline":"impl","findings":[]}' },
          { output: '{"criteriaCovered":["structure"],"findings":[]}' }, // valid reviewAnswerSchema
        ],
      });
      const h = await boot({ provider: cleanProvider, cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'review', target: { paths: ['/tmp/a.ts'] } });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        const out = env.output as Record<string, unknown>;
        expect(out).toHaveProperty('reviewerNote');
        expect(out.reviewerNote).toBeNull();
      } finally { await h.close(); }
    });
  });

  // ── Input validation ──

  describe('input validation', () => {
    /**
     * Each of these supplies EVERY required field for its type, so the only thing left to
     * reject is the retired one.
     *
     * They previously sent the retired field alone — `{ type: 'investigate', question: 'test' }`
     * with no `prompt` — which a 400 answers for the missing required field whether or not the
     * schema is strict. Five cases named for rejecting retired fields, all five passing on a
     * request that was invalid for an unrelated reason: if `taskInputSchema` ever stopped being
     * strict, every one of them would still be green.
     */
    const RETIRED_FIELD_CASES: Array<{ label: string; body: Record<string, unknown>; field: string }> = [
      { label: 'question (investigate)', field: 'question', body: { type: 'investigate', prompt: 'what is going on', question: 'test' } },
      { label: 'errorMessage (debug)', field: 'errorMessage', body: { type: 'debug', prompt: 'why does it fail', errorMessage: 'test' } },
      { label: 'filePaths (audit)', field: 'filePaths', body: { type: 'audit', target: { inline: 'doc' }, filePaths: ['a.md'] } },
      { label: 'taskDescriptors (execute_plan)', field: 'taskDescriptors', body: { type: 'execute_plan', target: { paths: ['p.md'] }, tasks: [], taskDescriptors: ['1'] } },
      { label: 'tasks array (delegate)', field: 'tasks', body: { type: 'delegate', prompt: 'do the thing', tasks: [{ prompt: 'x' }] } },
    ];

    it.each(RETIRED_FIELD_CASES)('rejects the retired $label on an otherwise VALID request', async ({ body, field }) => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, body);
        expect(res.status).toBe(400);
        // ...and names it, so the 400 cannot be coming from something else in the body.
        expect(JSON.stringify(await res.json())).toContain(field);
      } finally { await h.close(); }
    });

    it.each(RETIRED_FIELD_CASES)('...and accepts the same request once $label is removed', async ({ body, field }) => {
      // The control: proves the body is otherwise complete, so the rejection above is
      // attributable to the retired key and to nothing else.
      const { [field]: _retired, ...clean } = body;
      const tmp = await mkdtemp(join(tmpdir(), 'mma-retired-field-'));
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await dispatchCwd(h, tmp, clean);
        expect(res.status, `${field} removed should leave a valid request`).toBe(202);
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

    it('rejects unknown task type with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, { type: 'bogus', prompt: 'test' });
        expect(res.status).toBe(400);
        // Names the discriminator, so this cannot pass on an unrelated validation failure.
        expect(JSON.stringify(await res.json())).toContain('type');
      } finally { await h.close(); }
    });

    it('accepts delegate flat shape (prompt, not tasks array)', async () => {
      // MUST run against a throwaway dir, never `process.cwd()`. `delegate` is a WRITE route:
      // dispatching it at the engine checkout makes the engine commit in this repo. That is not
      // hypothetical — it committed a developer's uncommitted work here under
      // "[mma] delegate: do something" before the no-op guard in repo-commit.ts existed.
      const tmp = await mkdtemp(join(tmpdir(), 'mma-shape-'));
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({ type: 'delegate', prompt: 'do something' }),
        });
        expect(res.status).toBe(202);
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

  });

  // ── Unknown executionId ──

  describe('unknown executionId', () => {
    it('returns 404 for nonexistent executionId', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await fetch(`${h.baseUrl}/execution/00000000-0000-0000-0000-000000000000`, {
          headers: HEADERS(h.token),
        });
        expect(res.status).toBe(404);
      } finally { await h.close(); }
    });
  });

  // ── Non-git targets: write routes run in-place, worktree stays null (optional worktree) ──

  describe('non-git write-route execution', () => {
    it('delegate keeps execution.worktree null for a non-git cwd target', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'mma-nongit-'));   // no .git created
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({ type: 'delegate', prompt: 'touch a note' }),
        });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        expect((env.execution as Record<string, unknown>).worktree).toBeNull();
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

    it('execute_plan runs in-place (worktree null) for a non-git cwd target', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'mma-nongit-ep-'));
      await writeFile(join(tmp, 'plan.md'), '# Plan\n\n### Task 1: noop\n\n- [ ] Step 1: do nothing\n');
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({ type: 'execute_plan', target: { paths: ['plan.md'] } }),
        });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);
        expect((env.execution as Record<string, unknown>).worktree).toBeNull();
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

    it('delegate on a GIT cwd creates no branch and no worktree — it stays on the caller branch', async () => {
      // Isolated temp git repo (not the engine repo) so the git path is exercised deterministically.
      const tmp = await mkdtemp(join(tmpdir(), 'mma-git-'));
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: tmp });
      await writeFile(join(tmp, 'f.txt'), 'x\n');
      execFileSync('git', ['add', '-A'], { cwd: tmp });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: tmp });
      // The caller owns the branch — exactly what /mma:flow and Forge do before dispatching.
      execFileSync('git', ['checkout', '-q', '-b', 'mma/2026-07-31-demo'], { cwd: tmp });

      const branchesBefore = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: tmp, encoding: 'utf8' })
        .split('\n').map(s => s.trim()).filter(Boolean).sort();

      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({ type: 'delegate', prompt: 'touch a note' }),
        });
        const { executionId } = (await res.json()) as { executionId: string };
        const env = await pollToTerminal(h, executionId);

        // The engine owns no worktree any more; the key stays present and null.
        const execution = env.execution as Record<string, unknown>;
        expect(execution.worktree).toBeNull();
        expect(typeof execution.dirtyAtDispatch).toBe('boolean');

        // It created NO branch of its own …
        const branchesAfter = execFileSync('git', ['branch', '--format=%(refname:short)'], { cwd: tmp, encoding: 'utf8' })
          .split('\n').map(s => s.trim()).filter(Boolean).sort();
        expect(branchesAfter).toEqual(branchesBefore);

        // … left the caller's branch checked out …
        const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
        expect(head).toBe('mma/2026-07-31-demo');

        // … and created no worktree directory.
        expect(existsSync(join(tmp, '.mma', 'worktrees'))).toBe(false);
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });
  });

  // ── Deliverable Contract boundary (I-3): the filesystem-dependent checks core cannot
  //    do — realpath containment, disposition/git feasibility. The digest-mismatch case
  //    is covered by deliverable-contract-boundary.test.ts; this covers INV-3 disposition
  //    feasibility, which needs a real (non-git) cwd. ──

  describe('Deliverable Contract boundary — disposition feasibility', () => {
    it('rejects disposition "pr" for a non-git cwd, naming the field in fieldErrors.deliverable', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'mma-deliverable-nongit-'));
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const contractContent = {
          kind: 'report', audience: 'board', disposition: 'pr' as const,
          artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
          acceptance: [{ id: 'review', criterion: 'Reviewed', method: 'human' as const, references: [{ kind: 'none', reason: 'Owner judgement' }] }],
        };
        const digest = canonicalContractDigest(contractContent);
        const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({
            type: 'plan', prompt: 'plan', target: { inline: 'spec' },
            deliverable: {
              state: 'approved', ...contractContent,
              contractApproval: { contractDigest: digest, approvedBy: 'Owner', approvedAt: '2026-08-08T00:00:00.000Z' },
            },
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; details: { fieldErrors: { fieldErrors: Record<string, string[]> } } } };
        expect(body.error.code).toBe('invalid_request');
        expect(body.error.details.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/requires the workspace root to be a git repository/);
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

    it('permits disposition "deliver-file" for the SAME non-git cwd — only pr/commit-in-place require git', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'mma-deliverable-nongit-'));
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: tmp });
      try {
        const contractContent = {
          kind: 'report', audience: 'board', disposition: 'deliver-file' as const,
          artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
          acceptance: [{ id: 'review', criterion: 'Reviewed', method: 'human' as const, references: [{ kind: 'none', reason: 'Owner judgement' }] }],
        };
        const digest = canonicalContractDigest(contractContent);
        const res = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(tmp)}`, {
          method: 'POST', headers: HEADERS(h.token),
          body: JSON.stringify({
            type: 'plan', prompt: 'plan', target: { inline: 'spec' },
            deliverable: {
              state: 'approved', ...contractContent,
              contractApproval: { contractDigest: digest, approvedBy: 'Owner', approvedAt: '2026-08-08T00:00:00.000Z' },
            },
          }),
        });
        expect(res.status).toBe(202);
      } finally { await h.close(); await rm(tmp, { recursive: true, force: true }); }
    });

    it('rejects deliverable on a route that does not declare it (investigate) with 400', async () => {
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const res = await dispatch(h, {
          type: 'investigate',
          prompt: 'what is going on here',
          deliverable: { state: 'draft', audience: 'board' },
        });
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain('deliverable');
      } finally { await h.close(); }
    });
  });
}, 60_000);
