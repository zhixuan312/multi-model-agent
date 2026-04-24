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
    expect(readLines(dir)).toEqual([]);
  });
});
