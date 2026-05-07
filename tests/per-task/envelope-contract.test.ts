import { describe, it, expect } from 'vitest';
import * as schemas from '@zhixuan92/multi-model-agent-core/tools/index';

const REQUIRED_FIELDS = ['headline','results','batchTimings','costSummary','structuredReport','error'] as const;
const full = {
  headline: 'h',
  results: [],
  batchTimings: {},
  costSummary: {},
  structuredReport: {},
  error: { kind: 'not_applicable' as const, reason: 'ok' },
};

describe('every executor output envelope has all 6 required fields', () => {
  for (const [name, schema] of [
    ['delegate', schemas.delegate.outputSchema],
    ['audit', schemas.audit.outputSchema],
    ['review', schemas.review.outputSchema],
    ['verify', schemas.verify.outputSchema],
    ['debug', schemas.debug.outputSchema],
    ['executePlan', schemas.executePlan.outputSchema],
    ['retry', schemas.retry.outputSchema],
  ] as const) {
    it(`${name} rejects envelope missing any required field`, () => {
      for (const missing of REQUIRED_FIELDS) {
        const partial: Record<string, unknown> = { ...full };
        delete partial[missing];
        expect(() => schema.parse(partial), `missing ${missing} should fail`).toThrow();
      }
    });
  }
});
