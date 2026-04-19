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
    expect(result.content).toHaveLength(1);
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.headline).toBeTruthy();
    expect(envelope.batchId).toBeTruthy();
    expect(envelope.results).toHaveLength(1);
    expect(envelope.results[0].status).toBe('ok');
    expect(envelope.results[0].output).toBe('audit output');
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
    expect(envelope.headline).toBeTruthy();
    expect(envelope.batchId).toBeTruthy();
    expect(envelope.results).toHaveLength(2);
    expect(envelope.results[0].status).toBe('ok');
    expect(envelope.results[1].status).toBe('ok');
  });



  it('propagates parentModel from config into task spec (single-task)', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    await getHandler()({ document: 'doc', auditType: 'correctness' });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks[0].parentModel).toBe('claude-opus-4-6');
  });

  it('propagates parentModel from config into task spec (fan-out)', async () => {
    mockRunTasks.mockResolvedValue([mockResult(), mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    await getHandler()({ auditType: 'security', filePaths: ['a.ts', 'b.ts'] });
    const tasks = mockRunTasks.mock.calls[0][0];
    expect(tasks[0].parentModel).toBe('claude-opus-4-6');
    expect(tasks[1].parentModel).toBe('claude-opus-4-6');
  });

  it('headline reflects saved cost when parentModel is configured (single-task)', async () => {
    mockRunTasks.mockResolvedValue([mockResult({
      usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUSD: 0.10, savedCostUSD: 0.08 },
    })]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    const result = await getHandler()({ document: 'doc', auditType: 'correctness' });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.headline).toContain('$0.08 saved vs claude-opus-4-6');
    expect(envelope.headline).toContain('1.8x ROI');
    expect(envelope.headline).not.toContain('$0.00 saved');
  });

  it('headline reflects saved cost when parentModel is configured (fan-out)', async () => {
    mockRunTasks.mockResolvedValue([
      mockResult({ usage: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, costUSD: 0.05, savedCostUSD: 0.04 } }),
      mockResult({ usage: { inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, costUSD: 0.05, savedCostUSD: 0.04 } }),
    ]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, { defaults: { parentModel: 'claude-opus-4-6' } } as any);

    const result = await getHandler()({ auditType: 'security', filePaths: ['a.ts', 'b.ts'] });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.headline).toContain('$0.08 saved vs claude-opus-4-6');
    expect(envelope.headline).not.toContain('$0.00 saved');
  });

  it('headline shows actual cost when parentModel is absent', async () => {
    mockRunTasks.mockResolvedValue([mockResult({
      usage: { inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUSD: 0.10 },
    })]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, { defaults: {} } as any);

    const result = await getHandler()({ document: 'doc', auditType: 'correctness' });
    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.headline).toContain('$0.10 actual');
    expect(envelope.headline).not.toContain('saved vs');
  });

  it('resolves general auditType to all categories', async () => {
    mockRunTasks.mockResolvedValue([mockResult()]);
    const { mockServer, getHandler } = captureTool();
    registerAuditDocument(mockServer as any, {} as any);

    await getHandler()({ document: 'doc', auditType: 'general' });
    expect(mockRunTasks.mock.calls[0][0][0].prompt).toContain('security, performance, correctness, and style');
  });

});
