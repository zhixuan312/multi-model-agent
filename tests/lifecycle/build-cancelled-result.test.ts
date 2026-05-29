import { describe, it, expect } from 'bun:test';
import { buildCancelledResult } from '../../packages/core/src/lifecycle/build-cancelled-result.js';

describe('buildCancelledResult', () => {
  it('returns a RuntimeRunResult with workerStatus=failed and reason=cancelled', () => {
    const r = buildCancelledResult();
    expect(r.workerStatus).toBe('failed');
    expect(r.errorCode).toBe('cancelled');
    expect(r.actualCostUSD).toBe(0);
    expect(r.durationMs).toBe(0);
    expect(r.directoriesListed).toEqual([]);
  });
});
