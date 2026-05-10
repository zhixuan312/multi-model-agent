import { describe, it, expect, vi } from 'vitest';
import { dispatchParallelCriteria } from '../../packages/core/src/lifecycle/parallel-criteria-dispatcher.js';
import type { CriterionEntry } from '../../packages/core/src/tools/criteria-types.js';

const CRITERIA: readonly CriterionEntry[] = [
  { id: '1', title: 'A', description: 'first criterion description text more than twenty chars' },
  { id: '2', title: 'B', description: 'second criterion description text more than twenty chars' },
  { id: '3', title: 'C', description: 'third criterion description text more than twenty chars' },
];

const buildSuffix = (c: CriterionEntry) => `Your assignment: criterion ${c.id} — "${c.title}". ${c.description}`;

interface MockRunResp { status: 'ok' | 'error'; output: string; }

function makeShellWithStaticResults(perCriterion: Record<string, MockRunResp>) {
  const prime = vi.fn(async () => ({
    cacheWritten: true,
    durationMs: 100,
    usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  }));
  const run = vi.fn(async (input: any) => {
    const id = (input.userMessage as string).match(/criterion (\d+)/)?.[1] ?? '?';
    const result = perCriterion[id];
    if (!result) throw new Error(`unmocked criterion ${id}`);
    return {
      finalAssistantText: result.output,
      workerStatus: result.status === 'ok' ? 'done' : 'failed',
      ...(result.status === 'error' && { errorCode: 'transport_failure' as const }),
      usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 80, cachedNonReadTokens: 0 },
      turns: 1,
      toolCalls: [],
      filesRead: [],
      filesWritten: [],
      durationMs: 50,
      costUSD: 0.01,
    };
  });
  return { prime, run } as any;
}

describe('dispatchParallelCriteria', () => {
  it('calls prime() once and dispatches N sub-workers in parallel', async () => {
    const shell = makeShellWithStaticResults({
      '1': { status: 'ok', output: '## Finding 1: thing one' },
      '2': { status: 'ok', output: 'No findings for this criterion.' },
      '3': { status: 'ok', output: '## Finding 1: thing three' },
    });
    const result = await dispatchParallelCriteria({
      shell,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
    });
    expect(shell.prime).toHaveBeenCalledTimes(1);
    expect(shell.run).toHaveBeenCalledTimes(3);
    expect(result.partialCriteriaCovered).toEqual(['1', '2', '3']);
    expect(result.partialCriteriaFailed).toEqual([]);
    expect(result.workerOutputs).toHaveLength(3);
    expect(result.totalUsage.inputTokens).toBe(300);
    expect(result.totalUsage.cachedReadTokens).toBe(240);
    expect(result.warmCacheWritten).toBe(true);
  });

  it('retries failed sub-workers exactly once on warm cache', async () => {
    let call2Count = 0;
    const prime = vi.fn(async () => ({
      cacheWritten: true,
      durationMs: 100,
      usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    }));
    const run = vi.fn(async (input: any) => {
      const id = (input.userMessage as string).match(/criterion (\d+)/)?.[1] ?? '?';
      if (id === '2') {
        call2Count++;
        if (call2Count === 1) {
          return {
            finalAssistantText: '',
            workerStatus: 'failed',
            errorCode: 'transport_failure' as const,
            usage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            turns: 0,
            toolCalls: [],
            filesRead: [],
            filesWritten: [],
            durationMs: 10,
            costUSD: 0,
          };
        }
        return {
          finalAssistantText: '## Finding 1: recovered after retry',
          workerStatus: 'done' as const,
          usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 100, cachedNonReadTokens: 0 },
          turns: 1,
          toolCalls: [],
          filesRead: [],
          filesWritten: [],
          durationMs: 30,
          costUSD: 0.005,
        };
      }
      return {
        finalAssistantText: `## Finding 1: ok ${id}`,
        workerStatus: 'done' as const,
        usage: { inputTokens: 100, outputTokens: 50, cachedReadTokens: 0, cachedNonReadTokens: 0 },
        turns: 1,
        toolCalls: [],
        filesRead: [],
        filesWritten: [],
        durationMs: 50,
        costUSD: 0.01,
      };
    });
    const shell = { prime, run } as any;
    const result = await dispatchParallelCriteria({
      shell,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
    });
    expect(call2Count).toBe(2);
    expect(result.partialCriteriaCovered.sort()).toEqual(['1', '2', '3']);
    expect(result.partialCriteriaFailed).toEqual([]);
  });

  it('fail-soft: when retries also fail, drops from coverage and records failure with reason', async () => {
    const shell = makeShellWithStaticResults({
      '1': { status: 'ok', output: '## Finding 1: ok' },
      '2': { status: 'error', output: '' },
      '3': { status: 'ok', output: '## Finding 1: ok' },
    });
    const result = await dispatchParallelCriteria({
      shell,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
    });
    expect(result.partialCriteriaCovered).toEqual(['1', '3']);
    expect(result.partialCriteriaFailed).toHaveLength(1);
    expect(result.partialCriteriaFailed[0]).toEqual({
      id: '2',
      title: 'B',
      reason: 'transport',
      lastError: 'transport_failure',
    });
  });

  it('emits per-sub-worker observability events through the bus', async () => {
    const events: any[] = [];
    const bus = {
      on: vi.fn(),
      emit: (e: any) => events.push(e),
    } as any;
    const shell = makeShellWithStaticResults({
      '1': { status: 'ok', output: '## Finding 1: a' },
      '2': { status: 'ok', output: 'No findings for this criterion.' },
      '3': { status: 'ok', output: '## Finding 1: c\n## Finding 2: d' },
    });
    await dispatchParallelCriteria({
      shell,
      cachedPrefix: 'PREFIX',
      criteria: CRITERIA,
      buildSuffix,
      cwd: '/tmp',
      bus,
      route: 'audit',
    });
    const names = events.map(e => e.event);
    expect(names).toContain('criteria_fanout_warm_start');
    expect(names.filter(n => n === 'criteria_subworker_started')).toHaveLength(3);
    expect(names.filter(n => n === 'criteria_subworker_completed')).toHaveLength(3);
    const findingsByCriterion = events
      .filter(e => e.event === 'criteria_subworker_completed')
      .reduce((m, e) => Object.assign(m, { [e.criterionId]: e.findingsCount }), {} as Record<string, number>);
    expect(findingsByCriterion['3']).toBe(2);
  });
});
