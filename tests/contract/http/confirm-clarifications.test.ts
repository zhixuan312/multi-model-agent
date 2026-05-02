import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boot } from '../fixtures/harness.js';
import { mockProvider } from '../fixtures/mock-providers.js';
import {
  __forceClarificationGlobal,
  __clearForcedClarification,
} from '../../../packages/core/src/intake/force-clarification.js';

describe('HTTP /clarifications/confirm round-trip', () => {
  let baseUrl: string;
  let token: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MMAGENT_TEST_SEAMS = '1';
    __forceClarificationGlobal('which X did you mean?');
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    baseUrl = h.baseUrl;
    token = h.token;
    close = h.close;
  });

  afterEach(async () => {
    __clearForcedClarification();
    delete process.env.MMAGENT_TEST_SEAMS;
    await close();
  });

  it('full lifecycle: dispatch -> awaiting -> confirm -> resume -> success', async () => {
    // Dispatch
    const dispatchResp = await fetch(`${baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tasks: [{ prompt: 'do X' }] }),
    });
    expect(dispatchResp.status).toBe(202);
    const { batchId } = (await dispatchResp.json()) as { batchId: string };
    expect(batchId).toBeTruthy();

    // Poll until awaiting_clarification — discriminator: proposedInterpretation
    // is a non-empty string (not a { kind: 'not_applicable' } sentinel)
    let envelope: any;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${baseUrl}/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 200) {
        envelope = await r.json();
        if (typeof envelope.proposedInterpretation === 'string' && envelope.proposedInterpretation.length > 0) {
          break;
        }
      } else if (r.status === 202) {
        // still in flight, continue polling
      } else {
        throw new Error(`unexpected status ${r.status}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(envelope.proposedInterpretation).toBeTruthy();
    expect(typeof envelope.proposedInterpretation).toBe('string');
    expect(envelope.proposedInterpretation).toContain('which X');

    // Confirm
    const confirmResp = await fetch(`${baseUrl}/clarifications/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ batchId, interpretation: 'I meant rewrite' }),
    });
    expect(confirmResp.status).toBe(200);

    // Poll until terminal success — discriminator: proposedInterpretation is
    // a sentinel object { kind: 'not_applicable' } (no longer a string)
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${baseUrl}/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 200) {
        const final = await r.json();
        const interpretationIsSentinel =
          typeof final.proposedInterpretation === 'object' &&
          final.proposedInterpretation !== null &&
          final.proposedInterpretation.kind === 'not_applicable';
        if (interpretationIsSentinel) {
          expect(final.error.kind).toBe('not_applicable');
          expect(final.results).toBeInstanceOf(Array);
          expect(final.results.length).toBeGreaterThan(0);
          return;
        }
        // May be the awaiting_clarification envelope if confirm hasn't
        // been processed yet — continue polling
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('did not reach terminal success after confirm');
  }, 30_000);
});
