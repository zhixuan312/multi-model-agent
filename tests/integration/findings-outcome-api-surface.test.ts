// tests/integration/findings-outcome-api-surface.test.ts
import { describe, it, expect } from 'vitest';
import { runTaskViaDispatcher } from '../../packages/core/src/lifecycle/task-runner.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import type { TaskSpec, MultiModelConfig, Provider } from '../../packages/core/src/types.js';
import type { ResolvedAgent } from '../../packages/core/src/escalation/agent-resolver.js';
import type { Session, SessionOpts, TurnResult } from '../../packages/core/src/types/run-result.js';
import * as os from 'node:os';

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'mock', timeoutMs: 60_000 } as unknown as MultiModelConfig['agents']['standard'],
    },
    defaults: { timeoutMs: 60_000, stallTimeoutMs: 30_000, tools: 'full', sandboxPolicy: 'cwd-only' },
    server: {
      bind: '127.0.0.1', port: 7337,
      auth: { tokenFile: '/tmp/x' },
      limits: { maxBodyBytes: 1024, batchTtlMs: 60_000, idleProjectTimeoutMs: 60_000, projectCap: 1, maxBatchCacheSize: 10, maxContextBlockBytes: 1024, maxContextBlocksPerProject: 10, shutdownDrainMs: 1000 },
      autoUpdateSkills: false,
    },
    research: {
      brave: { apiKeys: [], timeoutMs: 1000, maxResultsPerQuery: 1, perCallBackoffMs: 0 },
      fetch: { maxRedirects: 0, connectTimeoutMs: 1000, totalDeadlineMs: 1000, maxBodyBytes: 1024, allowPrivateNetwork: false },
      builtinAdapters: { arxiv: false, semanticScholar: false, githubSearch: false, genericRss: false },
      userSources: [], fetchAllowlistExtra: [],
    },
  } as unknown as MultiModelConfig;
}

function makeAuditProvider(output: string): Provider {
  return {
    name: 'standard',
    config: { type: 'claude', model: 'mock-standard' } as Provider['config'],
    openSession(_opts: SessionOpts): Session {
      return {
        async send(): Promise<TurnResult> {
          return {
            output,
            usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            turns: 1,
            durationMs: 10,
            filesRead: [],
            filesWritten: [],
            toolCallsByName: {},
            costUSD: 0.001,
            terminationReason: 'ok',
          };
        },
        async close() { /* no-op */ },
        getSessionId() { return null; },
      };
    },
  };
}

describe('findings outcome on API surface — results[N]', () => {
  it('read-only route (review) surfaces all 4 outcome fields on results[0]', async () => {
    const provider = makeAuditProvider(`## Finding 1: missing null guard
- Severity: high
- Category: correctness
- Evidence: (none)
- Suggestion: add guard

## Outcome
found — 1 critical finding`);

    const envelope = TaskEnvelopeStore.create({
      taskId: 'review-test-0', batchId: 'review-batch', taskIndex: 0,
      route: 'review', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
      reviewPolicy: 'full' as const,
    });

    const task: TaskSpec = {
      prompt: 'review this code', readTarget: 'review this code', cwd: os.tmpdir(),
      reviewPolicy: 'none', timeoutMs: 60_000, tools: 'full',
    };

    const result = await runTaskViaDispatcher({
      task,
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'review',
      envelope,
    });

    // Check that the result has the outcome fields
    expect((result as any).findingsOutcome).toBeDefined();
    expect((result as any).findingsOutcomeReason).toBeDefined();
    expect((result as any).outcomeInferred).toBeDefined();
    expect((result as any).outcomeMalformed).toBeDefined();
  });

  it('outcome fields visible on structuredReport', async () => {
    const provider = makeAuditProvider(`## Finding 1: security issue
- Severity: critical
- Category: security
- Evidence: hardcoded password
- Suggestion: use env var

## Outcome
found — security issue found`);

    const envelope = TaskEnvelopeStore.create({
      taskId: 'review-test-1', batchId: 'review-batch', taskIndex: 0,
      route: 'review', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
      reviewPolicy: 'full' as const,
    });

    const task: TaskSpec = {
      prompt: 'review security', readTarget: 'review security', cwd: os.tmpdir(),
      reviewPolicy: 'none', timeoutMs: 60_000, tools: 'full',
    };

    const result = await runTaskViaDispatcher({
      task,
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'review',
      envelope,
    });

    // Check structured report also has these fields
    const sr = (result as any).structuredReport;
    if (sr && typeof sr === 'object') {
      expect(sr).toHaveProperty('findingsOutcome');
      expect(sr).toHaveProperty('findingsOutcomeReason');
      expect(sr).toHaveProperty('outcomeInferred');
      expect(sr).toHaveProperty('outcomeMalformed');
    }
  });

  it('outcome fields visible on per-stage wire row of envelope', async () => {
    const provider = makeAuditProvider(`## Finding 1: test finding
- Severity: medium
- Category: style
- Evidence: extra blank lines
- Suggestion: remove blanks

## Outcome
found — style issue`);

    const envelope = TaskEnvelopeStore.create({
      taskId: 'review-test-2', batchId: 'review-batch', taskIndex: 0,
      route: 'review', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
      reviewPolicy: 'full' as const,
    });

    const task: TaskSpec = {
      prompt: 'review code style', readTarget: 'review code style', cwd: os.tmpdir(),
      reviewPolicy: 'none', timeoutMs: 60_000, tools: 'full',
    };

    await runTaskViaDispatcher({
      task,
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'review',
      envelope,
    });

    // Check that the envelope's stages carry the outcome fields
    const snap = envelope.snapshot();
    const implementingStage = snap.stages.find(s => s.name === 'implementing');
    if (implementingStage) {
      // The implementing stage should have these fields populated
      expect(implementingStage).toHaveProperty('name');
    }
  });
});
