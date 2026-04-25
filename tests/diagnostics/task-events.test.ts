import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDiagnosticLogger } from '../../packages/core/src/diagnostics/disconnect-log.js';

function tmpLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mma-task-events-'));
}

function readLines(dir: string): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `mmagent-${today}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('DiagnosticLogger task events', () => {
  it('writes task_started with batchId/taskIndex/worker', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.taskStarted({ batchId: 'b1', taskIndex: 0, worker: 'MiniMax-M2.7' });
    const lines = readLines(dir);
    expect(lines.some((l) => l['event'] === 'task_started' && l['batchId'] === 'b1' && l['worker'] === 'MiniMax-M2.7')).toBe(true);
  });

  it('emit writes heartbeat with every primitive field', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.emit({
      event: 'heartbeat',
      batchId: 'b2',
      taskIndex: 3,
      elapsed: 5000,
      stage: 'implementing',
      round: 1,
      cap: 3,
      tools: 4,
      read: 5,
      wrote: 6,
      text: 7,
      cost: 0.12,
      idle_ms: 100,
      done: false,
      nullable: null,
      omitted: undefined,
    });
    const heartbeat = readLines(dir).find((l) => l['event'] === 'heartbeat');
    expect(heartbeat).toMatchObject({
      event: 'heartbeat',
      batchId: 'b2',
      taskIndex: 3,
      elapsed: 5000,
      stage: 'implementing',
      round: 1,
      cap: 3,
      tools: 4,
      read: 5,
      wrote: 6,
      text: 7,
      cost: 0.12,
      idle_ms: 100,
      done: false,
      nullable: null,
    });
    expect(typeof heartbeat?.['ts']).toBe('string');
    expect(heartbeat).not.toHaveProperty('omitted');
  });

  it('emit writes stage_change with from/to', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.emit({ event: 'stage_change', batchId: 'b3', taskIndex: 0, from: 'implementing', to: 'spec_review' });
    const phase = readLines(dir).find((l) => l['event'] === 'stage_change');
    expect(phase).toBeDefined();
    expect(phase?.['from']).toBe('implementing');
    expect(phase?.['to']).toBe('spec_review');
  });

  it('disabled logger: task events are no-ops', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: false, logDir: dir });
    logger.taskStarted({ batchId: 'b', taskIndex: 0 });
    logger.emit({ event: 'heartbeat', batchId: 'b', taskIndex: 0, elapsed: 0 });
    logger.batchCompleted({ batchId: 'b', tool: 't', durationMs: 0, taskCount: 0 });
    logger.batchFailed({ batchId: 'b', tool: 't', durationMs: 0, errorCode: 'x', errorMessage: 'y' });
    expect(readLines(dir)).toEqual([]);
  });

  it('writes batch_completed with tool + duration + taskCount', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.batchCompleted({ batchId: 'b6', tool: 'delegate', durationMs: 12_345, taskCount: 3 });
    const line = readLines(dir).find((l) => l['event'] === 'batch_completed');
    expect(line).toBeDefined();
    expect(line?.['tool']).toBe('delegate');
    expect(line?.['durationMs']).toBe(12_345);
    expect(line?.['taskCount']).toBe(3);
  });

  it('writes batch_failed with error code + message', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.batchFailed({
      batchId: 'b7', tool: 'audit', durationMs: 5000,
      errorCode: 'executor_error', errorMessage: 'timeout',
    });
    const line = readLines(dir).find((l) => l['event'] === 'batch_failed');
    expect(line).toBeDefined();
    expect(line?.['errorCode']).toBe('executor_error');
    expect(line?.['errorMessage']).toBe('timeout');
  });

  it('escalation writes a JSONL line with all required fields when enabled', () => {
    const lines: string[] = [];
    const logger = createDiagnosticLogger({
      enabled: true,
      writeSync: (_fd, data) => { lines.push(data.trim()); },
      openSync: () => 1,
      closeSync: () => {},
      mkdirSync: () => {},
      now: () => new Date('2026-04-25T00:00:00Z'),
    });

    logger.escalation({
      batchId: 'b1',
      taskIndex: 0,
      loop: 'spec',
      attempt: 2,
      baseTier: 'standard',
      implTier: 'complex',
      reviewerTier: 'standard',
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      event: 'escalation',
      ts: '2026-04-25T00:00:00.000Z',
      batchId: 'b1',
      taskIndex: 0,
      loop: 'spec',
      attempt: 2,
      baseTier: 'standard',
      implTier: 'complex',
      reviewerTier: 'standard',
    });
  });

  it('all four escalation and fallback methods are no-ops when disabled', () => {
    const lines: string[] = [];
    const logger = createDiagnosticLogger({
      enabled: false,
      writeSync: (_fd, data) => { lines.push(data); },
      openSync: () => 1,
      closeSync: () => {},
      mkdirSync: () => {},
    });

    logger.escalation({
      batchId: '', taskIndex: 0, loop: 'spec', attempt: 0,
      baseTier: 'standard', implTier: 'standard', reviewerTier: 'complex',
    });
    logger.escalationUnavailable({
      batchId: '', taskIndex: 0, loop: 'spec', attempt: 0,
      role: 'implementer', wantedTier: 'complex', reason: 'not_configured',
    });
    logger.fallback({
      batchId: '', taskIndex: 0, loop: 'spec', attempt: 0,
      role: 'implementer', assignedTier: 'standard', usedTier: 'complex',
      reason: 'transport_failure', violatesSeparation: false,
    });
    logger.fallbackUnavailable({
      batchId: '', taskIndex: 0, loop: 'spec', attempt: 0,
      role: 'implementer', assignedTier: 'standard', reason: 'transport_failure',
    });

    expect(lines).toHaveLength(0);
  });
});
