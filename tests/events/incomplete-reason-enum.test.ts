import { describe, it, expect } from 'vitest';
import { IncompleteReasonEnum } from '../../packages/core/src/events/event-base.js';

describe('IncompleteReasonEnum', () => {
  it('accepts the four spec values', () => {
    for (const v of ['turn_cap', 'cost_cap', 'timeout', 'missing_sections'] as const) {
      expect(() => IncompleteReasonEnum.parse(v)).not.toThrow();
    }
  });
  it('rejects legacy capExhausted values', () => {
    for (const v of ['turn', 'cost', 'wall_clock']) {
      expect(() => IncompleteReasonEnum.parse(v)).toThrow();
    }
  });
});
