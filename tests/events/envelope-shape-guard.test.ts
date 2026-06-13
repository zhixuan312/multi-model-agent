// tests/events/envelope-shape-guard.test.ts
import { describe, it, expect } from 'vitest';
import type { TaskEnvelope } from '../../packages/core/src/events/task-envelope.js';

describe('TaskEnvelope shape guard (A2)', () => {
  it('keyset matches the spec — no userMessage/assistantText/fileContents fields', () => {
    const allowedKeys = new Set([
      'taskId','batchId','taskIndex','route','agentType','client','mainModel','cwd','startedAt',
      'status','terminalAt','stopReason','structuredError','errorCode','reviewPolicy','plannedStageTotal',
      'stages','toolCalls','filesWritten','realFilesChanged',
      'commitSha','commitMessage','commitSkipReason','contextBlockId',
      'totalCostUSD','totalInputTokens','totalOutputTokens','totalCachedReadTokens','totalCachedNonReadTokens',
      'totalDurationMs','turnsUsed','stallCount','sandboxViolationCount','taskMaxIdleMs',
      'findings','sourcesUsed','escalationLog','validationWarnings','headline',
    ]);
    // Compile-time check: type literal of TaskEnvelope keys must be exactly allowedKeys.
    type Keys = keyof TaskEnvelope;
    const _typeCheck: Record<Keys, true> = {
      taskId: true, batchId: true, taskIndex: true, route: true, agentType: true,
      client: true, mainModel: true, cwd: true, startedAt: true,
      status: true, terminalAt: true, stopReason: true, structuredError: true,
      errorCode: true, reviewPolicy: true, plannedStageTotal: true,
      stages: true, toolCalls: true, filesWritten: true, realFilesChanged: true,
      commitSha: true, commitMessage: true, commitSkipReason: true, contextBlockId: true,
      totalCostUSD: true, totalInputTokens: true, totalOutputTokens: true,
      totalCachedReadTokens: true, totalCachedNonReadTokens: true,
      totalDurationMs: true, turnsUsed: true, stallCount: true, sandboxViolationCount: true, taskMaxIdleMs: true,
      findings: true, sourcesUsed: true, escalationLog: true, validationWarnings: true, headline: true,
    };
    expect(Object.keys(_typeCheck).sort()).toEqual([...allowedKeys].sort());
  });
});
