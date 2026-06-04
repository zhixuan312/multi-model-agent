import { describe, it, expect } from 'vitest';
import * as delegate from '../../packages/core/src/tools/delegate/schema.js';
import * as audit from '../../packages/core/src/tools/audit/schema.js';
import * as review from '../../packages/core/src/tools/review/schema.js';
import * as debug from '../../packages/core/src/tools/debug/schema.js';
import * as executePlan from '../../packages/core/src/tools/execute-plan/barrel.js';
import * as retry from '../../packages/core/src/tools/retry/schema.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';

const allSchemas = [
  ['delegate', delegate.outputSchema],
  ['audit', audit.outputSchema],
  ['review', review.outputSchema],
  ['debug', debug.outputSchema],
  ['executePlan', executePlan.outputSchema],
  ['retry', retry.outputSchema],
] as const;

describe('every tool output schema accepts NotApplicable on all five sentinel-bearing fields', () => {
  for (const [name, schema] of allSchemas) {
    it(`${name}: accepts NotApplicable for results/batchTimings/costSummary/structuredReport/error`, () => {
      const envelope = {
        headline: 'test',
        results: notApplicable('test'),
        batchTimings: notApplicable('test'),
        costSummary: notApplicable('test'),
        structuredReport: notApplicable('test'),
        error: notApplicable('test'),
      };
      expect(() => schema.parse(envelope)).not.toThrow();
    });

    it(`${name}: accepts concrete values for each field`, () => {
      const envelope = {
        headline: 'real',
        results: [],
        batchTimings: { wallClockMs: 0 },
        costSummary: { totalActualCostUSD: 0, costDeltaVsMainUSD: 0 },
        structuredReport: { summary: 'x' },
        error: { code: 'worker_timeout', message: 'timed out' },
      };
      expect(() => schema.parse(envelope)).not.toThrow();
    });

    it(`${name}: rejects missing headline`, () => {
      expect(() => schema.parse({ results: [], batchTimings: {}, costSummary: {}, structuredReport: {}, error: notApplicable('x') })).toThrow();
    });
  }
});
