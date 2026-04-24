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

  it('writes task_heartbeat with elapsedMs + stage', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.taskHeartbeat({ batchId: 'b2', taskIndex: 3, elapsedMs: 5000, stage: 'implementing' });
    const lines = readLines(dir);
    const heartbeat = lines.find((l) => l['event'] === 'task_heartbeat');
    expect(heartbeat).toBeDefined();
    expect(heartbeat?.['elapsedMs']).toBe(5000);
    expect(heartbeat?.['stage']).toBe('implementing');
    expect(heartbeat?.['taskIndex']).toBe(3);
  });

  it('writes task_phase_change with fromStage/toStage', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.taskPhaseChange({ batchId: 'b3', taskIndex: 0, fromStage: 'implementing', toStage: 'spec_review' });
    const lines = readLines(dir);
    const phase = lines.find((l) => l['event'] === 'task_phase_change');
    expect(phase).toBeDefined();
    expect(phase?.['fromStage']).toBe('implementing');
    expect(phase?.['toStage']).toBe('spec_review');
  });

  it('disabled logger: task events are no-ops', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: false, logDir: dir });
    logger.taskStarted({ batchId: 'b', taskIndex: 0 });
    logger.taskHeartbeat({ batchId: 'b', taskIndex: 0, elapsedMs: 0 });
    logger.taskPhaseChange({ batchId: 'b', taskIndex: 0, fromStage: 'x', toStage: 'y' });
    logger.toolCall({ batchId: 'b', taskIndex: 0, tool: 'x' });
    logger.llmTurn({ batchId: 'b', taskIndex: 0, turnIndex: 0 });
    logger.batchCompleted({ batchId: 'b', tool: 't', durationMs: 0, taskCount: 0 });
    logger.batchFailed({ batchId: 'b', tool: 't', durationMs: 0, errorCode: 'x', errorMessage: 'y' });
    expect(readLines(dir)).toEqual([]);
  });

  it('writes tool_call with tool + durationMs', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.toolCall({ batchId: 'b4', taskIndex: 2, tool: 'readFile(foo.ts)', durationMs: 42 });
    const line = readLines(dir).find((l) => l['event'] === 'tool_call');
    expect(line).toBeDefined();
    expect(line?.['tool']).toBe('readFile(foo.ts)');
    expect(line?.['durationMs']).toBe(42);
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

  it('writes llm_turn with provider + tokens + cost', () => {
    const dir = tmpLogDir();
    const logger = createDiagnosticLogger({ enabled: true, logDir: dir });
    logger.llmTurn({
      batchId: 'b5', taskIndex: 0, turnIndex: 3,
      provider: 'MiniMax-M2.7', inputTokens: 1234, outputTokens: 567, costUSD: 0.12,
    });
    const line = readLines(dir).find((l) => l['event'] === 'llm_turn');
    expect(line).toBeDefined();
    expect(line?.['provider']).toBe('MiniMax-M2.7');
    expect(line?.['inputTokens']).toBe(1234);
    expect(line?.['outputTokens']).toBe(567);
    expect(line?.['costUSD']).toBe(0.12);
  });
});
