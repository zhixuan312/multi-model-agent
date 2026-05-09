import { describe, it, expect } from 'vitest';
import { EventTypeEnum } from '../../packages/core/src/types/enums.js';

const ALL = [
  'batch_completed','batch_failed','cost_check','escalation','escalation_unavailable',
  'fallback','fallback_unavailable',
  'heartbeat','read_only_review.quality','read_only_review.terminal','review_decision',
  'stage_change','stall_abort','task_completed','task_started','text_emission',
  'time_check','tool_call','turn_complete','turn_start','verify_skipped','verify_step','worker_start',
] as const;

describe('EventTypeEnum', () => {
  it('accepts all 23 wire event names', () => {
    for (const v of ALL) {
      expect(() => EventTypeEnum.parse(v)).not.toThrow();
    }
  });
  it('rejects unknown values', () => {
    expect(() => EventTypeEnum.parse('not_an_event')).toThrow();
  });
});
