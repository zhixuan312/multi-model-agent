import { describe, it, expect } from 'vitest';
import { EventTypeEnum } from '../../packages/core/src/types/enums.js';

const ALL = [
  'batch_completed','batch_failed','cost_check','escalation','escalation_unavailable',
  'explore_external_unavailable','explore_internal_unavailable','explore_parallel_end',
  'explore_parallel_start','explore_synthesize_end','explore_synthesize_start',
  'explore_thread_completed','explore_thread_started','fallback','fallback_unavailable',
  'heartbeat','read_only_review.quality','read_only_review.terminal','review_decision',
  'stage_change','stall_abort','task_completed','task_started','text_emission',
  'time_check','tool_call','turn_complete','turn_start','verify_skipped','verify_step','worker_start',
] as const;

describe('EventTypeEnum', () => {
  it('accepts all 31 wire event names', () => {
    for (const v of ALL) {
      expect(() => EventTypeEnum.parse(v)).not.toThrow();
    }
  });
  it('rejects unknown values', () => {
    expect(() => EventTypeEnum.parse('not_an_event')).toThrow();
  });
});
