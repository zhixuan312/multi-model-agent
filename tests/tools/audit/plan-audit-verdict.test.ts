import { describe, it, expect } from 'vitest';
import {
  derivePlanTaskVerdicts,
  composePlanAuditSummary,
} from '../../../packages/core/src/tools/audit/plan-audit-verdict.js';

describe('derivePlanTaskVerdicts', () => {
  it('task with 0 critical and 0 high is EXECUTABLE', () => {
    const v = derivePlanTaskVerdicts([{ taskId: 'A1.1', severity: 'medium' }]);
    expect(v.get('A1.1')).toBe('EXECUTABLE');
  });

  it('task with ≥1 high and 0 critical is PARTIAL', () => {
    const v = derivePlanTaskVerdicts([
      { taskId: 'A1.2', severity: 'high' },
      { taskId: 'A1.2', severity: 'low' },
    ]);
    expect(v.get('A1.2')).toBe('PARTIAL');
  });

  it('task with ≥1 critical is BLOCKED regardless of other severities', () => {
    const v = derivePlanTaskVerdicts([
      { taskId: 'A1.3', severity: 'high' },
      { taskId: 'A1.3', severity: 'critical' },
    ]);
    expect(v.get('A1.3')).toBe('BLOCKED');
  });

  it('per-task grouping is independent across taskIds', () => {
    const v = derivePlanTaskVerdicts([
      { taskId: 'A1.1', severity: 'critical' },
      { taskId: 'A1.2', severity: 'high' },
      { taskId: 'A1.3', severity: 'low' },
    ]);
    expect(v.get('A1.1')).toBe('BLOCKED');
    expect(v.get('A1.2')).toBe('PARTIAL');
    expect(v.get('A1.3')).toBe('EXECUTABLE');
  });
});

describe('composePlanAuditSummary', () => {
  it('emits a 3-bucket count + Next blocker line for the lowest-numbered BLOCKED task', () => {
    const verdicts = new Map<string, 'EXECUTABLE' | 'PARTIAL' | 'BLOCKED'>([
      ['A1.1', 'EXECUTABLE'],
      ['A1.2', 'BLOCKED'],
      ['A1.3', 'PARTIAL'],
      ['A1.4', 'BLOCKED'],
    ]);
    const summary = composePlanAuditSummary(['A1.1', 'A1.2', 'A1.3', 'A1.4'], verdicts);
    expect(summary.executable).toEqual(['A1.1']);
    expect(summary.partial).toEqual(['A1.3']);
    expect(summary.blocked).toEqual(['A1.2', 'A1.4']);
    expect(summary.nextBlocker).toBe('A1.2');
    expect(summary.text).toContain('4 tasks audited');
    expect(summary.text).toContain('EXECUTABLE: 1');
    expect(summary.text).toContain('PARTIAL:    1');
    expect(summary.text).toContain('BLOCKED:    2');
    expect(summary.text).toContain('Next blocker: A1.2');
  });

  it('missing taskIds default to EXECUTABLE; no Next blocker line when 0 BLOCKED', () => {
    const verdicts = new Map<string, 'EXECUTABLE' | 'PARTIAL' | 'BLOCKED'>([['A2.1', 'PARTIAL']]);
    const summary = composePlanAuditSummary(['A2.1', 'A2.2'], verdicts);
    expect(summary.executable).toEqual(['A2.2']);
    expect(summary.partial).toEqual(['A2.1']);
    expect(summary.blocked).toEqual([]);
    expect(summary.nextBlocker).toBeNull();
    expect(summary.text).not.toContain('Next blocker');
  });
});
