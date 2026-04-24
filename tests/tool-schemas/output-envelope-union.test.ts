import { describe, it, expect } from 'vitest';
import * as delegate from '../../packages/core/src/tool-schemas/delegate.js';
import * as audit from '../../packages/core/src/tool-schemas/audit.js';
import * as review from '../../packages/core/src/tool-schemas/review.js';
import * as verify from '../../packages/core/src/tool-schemas/verify.js';
import * as debug from '../../packages/core/src/tool-schemas/debug.js';
import * as executePlan from '../../packages/core/src/tool-schemas/execute-plan.js';
import * as retry from '../../packages/core/src/tool-schemas/retry.js';
import { notApplicable } from '../../packages/core/src/reporting/not-applicable.js';

const allSchemas = [
  ['delegate', delegate.outputSchema],
  ['audit', audit.outputSchema],
  ['review', review.outputSchema],
  ['verify', verify.outputSchema],
  ['debug', debug.outputSchema],
  ['executePlan', executePlan.outputSchema],
  ['retry', retry.outputSchema],
] as const;

describe('every tool output schema accepts NotApplicable on all six sentinel-bearing fields', () => {
  for (const [name, schema] of allSchemas) {
    it(`${name}: accepts NotApplicable for results/batchTimings/costSummary/structuredReport/error/proposedInterpretation`, () => {
      const envelope = {
        headline: 'test',
        results: notApplicable('test'),
        batchTimings: notApplicable('test'),
        costSummary: notApplicable('test'),
        structuredReport: notApplicable('test'),
        error: notApplicable('test'),
        proposedInterpretation: notApplicable('test'),
      };
      expect(() => schema.parse(envelope)).not.toThrow();
    });

    it(`${name}: accepts concrete values for each field`, () => {
      const envelope = {
        headline: 'real',
        results: [],
        batchTimings: { wallClockMs: 0 },
        costSummary: { totalActualCostUSD: 0, totalSavedCostUSD: 0 },
        structuredReport: { summary: 'x' },
        error: { code: 'worker_timeout', message: 'timed out' },
        proposedInterpretation: 'did you mean X?',
      };
      expect(() => schema.parse(envelope)).not.toThrow();
    });

    it(`${name}: rejects missing headline`, () => {
      expect(() => schema.parse({ results: [], batchTimings: {}, costSummary: {}, structuredReport: {}, error: notApplicable('x'), proposedInterpretation: notApplicable('x') })).toThrow();
    });
  }
});
