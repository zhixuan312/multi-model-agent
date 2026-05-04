import { describe, it, expect } from 'vitest';
import { ToolTracker } from '../../packages/core/src/runner-shell/tool-tracker.js';

describe('ToolTracker', () => {
  it('records and slices by turn', () => {
    const t = new ToolTracker();
    t.record({ name: 'a', turnIndex: 0, input: {}, result: {}, durationMs: 10 });
    t.record({ name: 'b', turnIndex: 1, input: {}, result: {}, durationMs: 20 });
    t.record({ name: 'c', turnIndex: 1, input: {}, result: {}, durationMs: 30 });
    expect(t.forTurn(0)).toHaveLength(1);
    expect(t.forTurn(1)).toHaveLength(2);
    expect(t.all()).toHaveLength(3);
  });
});
