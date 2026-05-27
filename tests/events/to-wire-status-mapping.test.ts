import { describe, it, expect } from 'bun:test';
import { mapStatusToWire } from '../../packages/core/src/events/to-wire-record.js';

describe('mapStatusToWire — exhaustive', () => {
  it.each([
    [{ status: 'done', err: null }, { terminalStatus: 'ok', workerStatus: 'done' }],
    [
      { status: 'done_with_concerns', err: null },
      { terminalStatus: 'ok', workerStatus: 'done_with_concerns' },
    ],
    [{ status: 'failed', err: 'incomplete' }, { terminalStatus: 'incomplete', workerStatus: 'failed' }],
    [{ status: 'failed', err: 'timeout' }, { terminalStatus: 'timeout', workerStatus: 'failed' }],
    [
      { status: 'failed', err: 'brief_too_vague' },
      { terminalStatus: 'brief_too_vague', workerStatus: 'failed' },
    ],
    [
      { status: 'failed', err: 'unavailable' },
      { terminalStatus: 'unavailable', workerStatus: 'failed' },
    ],
    [
      { status: 'failed', err: 'needs_context' },
      { terminalStatus: 'incomplete', workerStatus: 'needs_context' },
    ],
    [{ status: 'failed', err: 'blocked' }, { terminalStatus: 'incomplete', workerStatus: 'blocked' }],
    [
      { status: 'failed', err: 'review_loop_capped' },
      { terminalStatus: 'incomplete', workerStatus: 'review_loop_capped' },
    ],
    [{ status: 'failed', err: 'unknown_code' }, { terminalStatus: 'error', workerStatus: 'failed' }],
  ])('maps %j → %j', ({ status, err }, expected) => {
    expect(mapStatusToWire(status as never, err)).toEqual(expected);
  });
});
