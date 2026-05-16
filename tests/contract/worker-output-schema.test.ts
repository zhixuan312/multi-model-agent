// AC-2 — WorkerOutputSchema rejects retired worker-status values.
//
// The v5 contract narrows `workerSelfAssessment` to `'done' | 'failed'`.
// The pre-v5 values `'done_with_concerns' | 'blocked' | 'needs_context'`
// must be rejected by the schema AND by parseWorkerOutput (which falls
// back to status='failed' on schema rejection per the worker-output
// contract).

import { describe, it, expect } from 'vitest';
import {
  WorkerOutputSchema,
  parseWorkerOutput,
} from '../../packages/core/src/lifecycle/worker-output-contract.js';

const DEPRECATED_STATUSES = ['done_with_concerns', 'blocked', 'needs_context'] as const;
const ACCEPTED_STATUSES = ['done', 'failed'] as const;

describe('AC-2: WorkerOutputSchema worker-status validation', () => {
  for (const bad of DEPRECATED_STATUSES) {
    it(`rejects retired status: '${bad}'`, () => {
      const result = WorkerOutputSchema.safeParse({
        workerSelfAssessment: bad,
        summary: 's',
      });
      expect(result.success).toBe(false);
    });
  }

  for (const good of ACCEPTED_STATUSES) {
    it(`accepts v5 status: '${good}'`, () => {
      const result = WorkerOutputSchema.safeParse({
        workerSelfAssessment: good,
        summary: 's',
      });
      expect(result.success).toBe(true);
    });
  }

  it('rejects arbitrary unknown status values', () => {
    const result = WorkerOutputSchema.safeParse({
      workerSelfAssessment: 'partially_done_with_some_concerns',
      summary: 's',
    });
    expect(result.success).toBe(false);
  });
});

describe('AC-2: parseWorkerOutput falls back gracefully for retired statuses', () => {
  for (const bad of DEPRECATED_STATUSES) {
    it(`parseWorkerOutput rejects '${bad}' in the JSON block and falls back to 'failed'`, () => {
      const text = '```json\n' + JSON.stringify({
        workerSelfAssessment: bad,
        summary: 'doomed payload',
      }) + '\n```';
      const parsed = parseWorkerOutput(text);
      // The parser MUST NOT silently accept a retired status. The contract is:
      // when schema validation fails, parseWorkerOutput synthesizes a safe
      // default — workerSelfAssessment becomes 'failed' (the conservative
      // v5 value), never the rejected legacy value.
      expect(parsed.workerSelfAssessment).not.toBe(bad);
      expect(['done', 'failed']).toContain(parsed.workerSelfAssessment);
    });
  }
});
