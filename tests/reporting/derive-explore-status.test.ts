import { describe, expect, it } from 'vitest';
import { deriveExploreStatus } from '../../packages/core/src/reporting/derive-explore-status.js';

const ok = { malformed: false, insufficientThreads: false, droppedThreads: [] };

describe('deriveExploreStatus', () => {
  it('done on clean output', () => {
    const r = deriveExploreStatus({ workerError: undefined, incompleteReason: undefined, parseDiagnostics: ok, threads: 4 });
    expect(r.workerStatus).toBe('done');
  });

  it('failed when workerError present', () => {
    const r = deriveExploreStatus({ workerError: new Error('x'), incompleteReason: undefined, parseDiagnostics: ok, threads: 0 });
    expect(r.workerStatus).toBe('failed');
  });

  it('done_with_concerns + turn_cap when incompleteReason=turn_cap', () => {
    const r = deriveExploreStatus({ workerError: undefined, incompleteReason: 'turn_cap', parseDiagnostics: ok, threads: 3 });
    expect(r).toMatchObject({ workerStatus: 'done_with_concerns', incompleteReason: 'turn_cap' });
  });

  it('done_with_concerns + cost_cap when incompleteReason=cost_cap', () => {
    const r = deriveExploreStatus({ workerError: undefined, incompleteReason: 'cost_cap', parseDiagnostics: ok, threads: 3 });
    expect(r).toMatchObject({ workerStatus: 'done_with_concerns', incompleteReason: 'cost_cap' });
  });

  it('done_with_concerns + timeout when incompleteReason=timeout', () => {
    const r = deriveExploreStatus({ workerError: undefined, incompleteReason: 'timeout', parseDiagnostics: ok, threads: 3 });
    expect(r).toMatchObject({ workerStatus: 'done_with_concerns', incompleteReason: 'timeout' });
  });

  it('done_with_concerns + malformed_threads when parser flags malformed', () => {
    const r = deriveExploreStatus({ workerError: undefined, incompleteReason: undefined, parseDiagnostics: { malformed: true, insufficientThreads: false, droppedThreads: ['T2'] }, threads: 2 });
    expect(r).toMatchObject({ workerStatus: 'done_with_concerns', incompleteReason: 'malformed_threads' });
  });

  it('done_with_concerns + insufficient_threads when <3 threads', () => {
    const r = deriveExploreStatus({ workerError: undefined, incompleteReason: undefined, parseDiagnostics: { malformed: false, insufficientThreads: true, droppedThreads: [] }, threads: 2 });
    expect(r).toMatchObject({ workerStatus: 'done_with_concerns', incompleteReason: 'insufficient_threads' });
  });

  it('done_with_concerns + threads_dropped when droppedThreads non-empty', () => {
    const r = deriveExploreStatus({ workerError: undefined, incompleteReason: undefined, parseDiagnostics: { malformed: false, insufficientThreads: false, droppedThreads: ['T1', 'T3'] }, threads: 4 });
    expect(r).toMatchObject({ workerStatus: 'done_with_concerns', incompleteReason: 'threads_dropped' });
  });
});
