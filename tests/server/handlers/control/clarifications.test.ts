// tests/server/handlers/control/clarifications.test.ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';

async function postConfirm(
  serverUrl: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${serverUrl}/clarifications/confirm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /clarifications/confirm', () => {
  it('transitions awaiting_clarification batch to pending on confirm', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();

      // Register a batch as pending then transition to awaiting_clarification
      s.batchRegistry.register({
        batchId,
        projectCwd: '/tmp/test',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });

      // Set up a resolver so resumeFromClarification can call it
      let resolverCalled = false;
      const entry = s.batchRegistry.get(batchId)!;
      entry.resolveClarification = (_interp: string) => { resolverCalled = true; };
      s.batchRegistry.requestClarification(batchId, 'Did you mean X or Y?');

      // Verify it's in awaiting_clarification
      expect(s.batchRegistry.get(batchId)!.state).toBe('awaiting_clarification');

      const res = await postConfirm(s.url, s.token, {
        batchId,
        interpretation: 'I meant X',
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { batchId: string; state: string };
      expect(json.batchId).toBe(batchId);
      // After confirm, state transitions from awaiting_clarification → pending
      expect(json.state).toBe('pending');
      expect(resolverCalled).toBe(true);
    } finally {
      await s.stop();
    }
  });

  it('returns 404 not_found for unknown batchId', async () => {
    const s = await startTestServerWithAgents();
    try {
      const res = await postConfirm(s.url, s.token, {
        batchId: randomUUID(),
        interpretation: 'some interpretation',
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });

  it('returns 409 invalid_batch_state when batch is complete and interpretation differs', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId,
        projectCwd: '/tmp/test',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });
      // Mark complete first
      s.batchRegistry.complete(batchId, { results: [] });

      const res = await postConfirm(s.url, s.token, {
        batchId,
        interpretation: 'different interpretation',
      });
      expect(res.status).toBe(409);
      const json = await res.json() as { error: { code: string; details: { currentState: string } } };
      expect(json.error.code).toBe('invalid_batch_state');
      expect(json.error.details.currentState).toBe('complete');
    } finally {
      await s.stop();
    }
  });

  it('is idempotent: double-confirm with same interpretation returns 200 no-op', async () => {
    const s = await startTestServerWithAgents();
    try {
      const batchId = randomUUID();
      s.batchRegistry.register({
        batchId,
        projectCwd: '/tmp/test',
        tool: 'delegate',
        state: 'pending',
        startedAt: Date.now(),
        stateChangedAt: Date.now(),
        blockIds: [],
        blocksReleased: false,
      });

      const entry = s.batchRegistry.get(batchId)!;
      entry.resolveClarification = () => {};
      s.batchRegistry.requestClarification(batchId, 'Proposal?');

      const interpretation = 'chosen interpretation';

      // First confirm
      const res1 = await postConfirm(s.url, s.token, { batchId, interpretation });
      expect(res1.status).toBe(200);

      // After first confirm: state = pending, confirmedInterpretation = 'chosen interpretation'
      // Second confirm with same interpretation: no-op, should still return 200
      const res2 = await postConfirm(s.url, s.token, { batchId, interpretation });
      expect(res2.status).toBe(200);
      const json2 = await res2.json() as { batchId: string; state: string };
      expect(json2.batchId).toBe(batchId);
      // State may be 'pending' (still running) since there's no real executor
      expect(json2.state).toBeDefined();
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when batchId is not a UUID', async () => {
    const s = await startTestServerWithAgents();
    try {
      const res = await postConfirm(s.url, s.token, {
        batchId: 'not-a-uuid',
        interpretation: 'some interpretation',
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when interpretation is missing', async () => {
    const s = await startTestServerWithAgents();
    try {
      const res = await postConfirm(s.url, s.token, {
        batchId: randomUUID(),
        // no interpretation
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });
});
