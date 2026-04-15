import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditDocumentSchema, registerAuditDocument } from '@zhixuan92/multi-model-agent-mcp/tools/audit-document';
import type { RunResult } from '@zhixuan92/multi-model-agent-core';

// --- Schema tests ---

describe('audit_document schema', () => {
  it('accepts inline document with string auditType', () => {
    expect(auditDocumentSchema.safeParse({ document: 'content', auditType: 'security' }).success).toBe(true);
  });
  it('accepts filePaths without document', () => {
    expect(auditDocumentSchema.safeParse({ auditType: 'correctness', filePaths: ['a.ts', 'b.ts'] }).success).toBe(true);
  });
  it('accepts auditType as array', () => {
    expect(auditDocumentSchema.safeParse({ document: 'c', auditType: ['security', 'performance'] }).success).toBe(true);
  });
  it('accepts general auditType', () => {
    expect(auditDocumentSchema.safeParse({ document: 'c', auditType: 'general' }).success).toBe(true);
  });
  it('rejects invalid auditType', () => {
    expect(auditDocumentSchema.safeParse({ document: 'c', auditType: 'invalid' }).success).toBe(false);
  });
  it('rejects empty auditType array', () => {
    expect(auditDocumentSchema.safeParse({ document: 'c', auditType: [] }).success).toBe(false);
  });
  it('allows both absent (handler validates)', () => {
    expect(auditDocumentSchema.safeParse({ auditType: 'security' }).success).toBe(true);
  });
});

// --- Handler tests ---

vi.mock('@zhixuan92/multi-model-agent-core/run-tasks', () => ({
  runTasks: vi.fn(),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
const mockRunTasks = vi.mocked(runTasks);

function mockResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: 'audit output', status: 'ok',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3, durationMs: 5000,
    filesRead: [], filesWritten: [], toolCalls: [],
    outputIsDiagnostic: false, escalationLog: [],
    workerStatus: 'done', specReviewStatus: 'skipped', qualityReviewStatus: 'skipped',
    ...overrides,
  };
}

function captureTool() {
  let handler: Function;
  const mockServer = {
    tool: (_name: string, _desc: string, _schema: any, h: Function) => { handler = h; },
  };
  return { mockServer, getHandler: () => handler! };
}

describe('audit_document handler', () => {
  beforeEach(() => { mockRunTasks.mockReset(); });

  it('rejects when neither document nor filePaths provided', async () => {
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, {} as any);
    const result = await getHandler()({ auditType: 'security' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide content or filePaths');
  });

  it('single-task mode: dispatches 1 task with document', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, { defaults: { tools: 'readonly', timeoutMs: 600_000, maxCostUSD: 10, sandboxPolicy: 'cwd-only' } } as any);

    const result = await getHandler()({
      document: 'my doc', auditType: 'correctness',
      filePaths: ['ref.ts'],
    });

    expect(mockRunTasks).toHaveBeenCalledTimes(1);
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toContain('my doc');
    expect(tasks[0].prompt).toContain('ref.ts');
    expect(tasks[0].cwd).toBe(process.cwd());
    expect(tasks[0].tools).toBe('readonly');
    expect(tasks[0].reviewPolicy).toBe('off');
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toBe('audit output');
    const meta = JSON.parse(result.content[1].text);
    expect(meta.status).toBe('ok');
  });

  it('fan-out mode: dispatches N tasks when only filePaths provided', async () => {
    mockRunTasks.mockResolvedValue([mockResult(), mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, {} as any);

    const result = await getHandler()({ auditType: 'general', filePaths: ['a.ts', 'b.ts'] });

    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks).toHaveLength(2);
    expect(tasks[0].prompt).toContain('a.ts');
    expect(tasks[1].prompt).toContain('b.ts');
    expect(result.content).toHaveLength(1);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.mode).toBe('fan_out');
    expect(envelope.results).toHaveLength(2);
    expect(envelope).not.toHaveProperty('batchId');
  });



  it('resolves general auditType to all categories', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, {} as any);

    await getHandler()({ document: 'doc', auditType: 'general' });
    expect(mockRunTasks.mock.calls[0][0][0].prompt).toContain('security, performance, correctness, and style');
  });

});
