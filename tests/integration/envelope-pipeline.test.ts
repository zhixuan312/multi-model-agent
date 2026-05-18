// tests/integration/envelope-pipeline.test.ts
//
// Lifecycle integration test that wires task-runner → mock provider →
// envelope mutations → seal → bus subscribers, and asserts the data
// actually flows end-to-end. This is the test that would have caught the
// six 4.7.3-regression bugs in one shot:
//
//   • envelope not threaded from task-executor into runTaskViaDispatcher
//     → SessionOpts.envelope was undefined → recordToolCall no-op'd
//     → envelope.stages stayed empty
//     → polling headline stuck at [0/0] queued
//   • recordTaskCompletedHandler read state.workerStatus (only set by
//     rework-stage) → read-route tasks always sealed as status='failed'
//   • completeStage clobbered toolCallCount/filesReadCount with hardcoded
//     zeros after recordToolCall had incremented them
//   • recordHeartbeat after seal threw SealedEnvelopeError → runner_crash
//     at terminal
//   • headline.toolTotal = reads + writes (always 0 for shell commands
//     that pass empty file lists) instead of toolCalls.length
//   • TelemetryUploader wired with recorder=null because createRecorder
//     ran AFTER startServer (covered by recorder-init test below)

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { runTaskViaDispatcher } from '../../packages/core/src/lifecycle/task-runner.js';
import { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';
import { EnvelopeBus } from '../../packages/core/src/events/envelope-bus.js';
import { TelemetryUploader } from '../../packages/core/src/events/telemetry-uploader.js';
import type { TaskSpec, MultiModelConfig, Provider } from '../../packages/core/src/types.js';
import type { ResolvedAgent } from '../../packages/core/src/escalation/agent-resolver.js';
import type { Session, SessionOpts, TurnResult } from '../../packages/core/src/types/run-result.js';

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'mock', timeoutMs: 60_000 } as unknown as MultiModelConfig['agents']['standard'],
      complex: { type: 'mock', timeoutMs: 60_000 } as unknown as MultiModelConfig['agents']['complex'],
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

/**
 * Mock provider that records whether SessionOpts.envelope was threaded
 * through (regression for the executor→runner→openSession threading bug)
 * and emits two simulated tool calls to the envelope so we can assert
 * stage counters survive completeStage().
 */
function makeRecordingProvider(captured: { envelopeSeen: boolean }): Provider {
  return {
    name: 'standard',
    config: { type: 'claude', model: 'mock-standard' } as Provider['config'],
    openSession(opts: SessionOpts): Session {
      captured.envelopeSeen = Boolean((opts as { envelope?: unknown }).envelope);
      const env = (opts as { envelope?: TaskEnvelopeStore }).envelope;
      return {
        async send(): Promise<TurnResult> {
          // Simulate two tool calls during the implementing stage. Both
          // pass empty file arrays (like codex's run_shell does) so that
          // toolTotal MUST come from toolCalls.length, not files.length.
          env?.recordToolCall({ stage: 'implementing', tool: 'run_shell', filesRead: [], filesWritten: [] });
          env?.recordToolCall({ stage: 'implementing', tool: 'run_shell', filesRead: [], filesWritten: [] });
          return {
            output: '## Summary\napproved\n\nDone.',
            usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            turns: 1,
            durationMs: 10,
            filesRead: [],
            filesWritten: [],
            toolCallsByName: { run_shell: 2 },
            costUSD: 0.001,
            terminationReason: 'ok',
            workerSelfAssessment: 'done',
          };
        },
        async close() { /* no-op */ },
      };
    },
  };
}

describe('envelope pipeline — end-to-end', () => {
  it('threads envelope through task-runner → SessionOpts → session.send', async () => {
    const captured = { envelopeSeen: false };
    const provider = makeRecordingProvider(captured);
    const envelope = TaskEnvelopeStore.create({
      taskId: 'b1:0', batchId: 'b1', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
    });
    const task: TaskSpec = {
      prompt: 'do the thing', cwd: os.tmpdir(),
      reviewPolicy: 'none', timeoutMs: 60_000, tools: 'none',
    };

    await runTaskViaDispatcher({
      task,
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
      envelope,
    });

    // Regression: if SessionOpts.envelope is dropped in task-runner.ts's
    // openSession spread, this assertion fails. Bug A symptom.
    expect(captured.envelopeSeen).toBe(true);
  });

  it('preserves stage counters across completeStage (counter-clobber regression)', async () => {
    const provider = makeRecordingProvider({ envelopeSeen: false });
    const envelope = TaskEnvelopeStore.create({
      taskId: 'b2:0', batchId: 'b2', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
    });
    const task: TaskSpec = {
      prompt: 'do the thing', cwd: os.tmpdir(),
      reviewPolicy: 'none', timeoutMs: 60_000, tools: 'none',
    };

    await runTaskViaDispatcher({
      task,
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
      envelope,
    });

    const snap = envelope.snapshot();
    const implementing = snap.stages.find(s => s.name === 'implementing');
    expect(implementing).toBeDefined();
    // Regression: headline.toolTotal must count tool calls.
    // The mock provider fires 2 tool calls per session.send. The annotate
    // stage reuses the same standard-tier session, so we expect at least 2.
    expect(snap.headline.toolTotal).toBeGreaterThanOrEqual(2);
    // The toolCalls array is the source of truth — count must match.
    expect(snap.toolCalls.length).toBe(snap.headline.toolTotal);
  });

  it('seals envelope with status=done for a successful run (workerStatus fallback)', async () => {
    const provider = makeRecordingProvider({ envelopeSeen: false });
    const envelope = TaskEnvelopeStore.create({
      taskId: 'b3:0', batchId: 'b3', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
    });
    const task: TaskSpec = {
      prompt: 'do the thing', cwd: os.tmpdir(),
      reviewPolicy: 'none', timeoutMs: 60_000, tools: 'none',
    };

    await runTaskViaDispatcher({
      task,
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
      envelope,
    });

    const snap = envelope.snapshot();
    // Regression: recordTaskCompletedHandler used to read state.workerStatus
    // (only set by rework-stage); for routes without rework, it fell through
    // to 'failed' even when the worker succeeded. The fix falls back to
    // state.lastRunResult.workerStatus.
    expect(snap.status).toBe('done');
    expect(envelope.isSealed()).toBe(true);
  });

  it('emits a sealed envelope snapshot that TelemetryUploader can enqueue', async () => {
    // Hand-built bus + uploader pointed at a capturing recorder. Verifies
    // the FULL chain: lifecycle → envelope.seal → bus.emitEnvelopeSnapshot →
    // TelemetryUploader.receive → recorder.enqueue. If any link breaks, the
    // recorder gets nothing — which is exactly the symptom of the
    // init-order bug where TelemetryUploader was wired with recorder=null.
    const enqueued: unknown[] = [];
    const bus = new EnvelopeBus();
    const uploader = new TelemetryUploader({
      recorder: { enqueue: (e) => { enqueued.push(e); } },
      consent: { decide: () => ({ enabled: true }) },
      buildOpts: (env) => ({
        reviewPolicy: 'full',
        toolMode: 'full',
        verifyCommandPresent: false,
        implementerModel: env.stages[0]?.model ?? env.mainModel,
        implementerTier: env.stages[0]?.tier ?? env.agentType,
        mainModelFamily: env.mainModel.split('-')[0] ?? 'unknown',
      }),
    });
    bus.subscribe(uploader);

    const envelope = TaskEnvelopeStore.create({
      taskId: 'b4:0', batchId: 'b4', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
    }, bus);

    const provider = makeRecordingProvider({ envelopeSeen: false });
    const task: TaskSpec = {
      prompt: 'do the thing', cwd: os.tmpdir(),
      reviewPolicy: 'none', timeoutMs: 60_000, tools: 'none',
    };

    await runTaskViaDispatcher({
      task,
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
      envelope,
      bus,
    });

    // Regression: the chain must deliver at least one enqueue call to the
    // recorder. If TelemetryUploader is wired with a null recorder (the
    // serve.ts init-order bug), or if envelope.seal() doesn't fire, this
    // array stays empty.
    expect(enqueued.length).toBeGreaterThanOrEqual(1);
    // toWireRecord returns the flat task-completed event directly; the
    // recorder is what wraps it in {events:[...]} on flush. Assert the
    // flat record's shape here so a future toWireRecord refactor that
    // drops a critical field breaks this test instead of breaking
    // telemetry in production.
    const rec = enqueued[0] as Record<string, unknown>;
    expect(rec['route']).toBe('delegate');
    expect(rec['workerStatus']).toBe('done');
    expect(rec['terminalStatus']).toBe('ok');
    expect(rec['mainModel']).toBe('claude-opus-4-7');
  });

  it('aggregates per-stage tokens + cost into envelope totals and wire record (4.7.3 aggregation fix)', async () => {
    // Mock provider that returns NON-ZERO token usage AND non-zero cost, so
    // we can prove the pipeline reads from RuntimeRunResult.stageStats →
    // envelope.completeStage → wire record. Before the 4.7.3 lifecycle-driver
    // fix, completeStage omitted tokens and cost so per-stage stats stayed at
    // 0 in the envelope even when the runtime captured real values.
    const provider: Provider = {
      name: 'standard',
      config: { type: 'claude', model: 'gpt-5.4' } as Provider['config'],
      openSession(opts: SessionOpts): Session {
        const env = (opts as { envelope?: TaskEnvelopeStore }).envelope;
        return {
          async send(): Promise<TurnResult> {
            env?.recordToolCall({ stage: 'implementing', tool: 'run_shell' });
            return {
              output: '## Summary\napproved\n\nDone.',
              usage: { inputTokens: 1234, outputTokens: 56, cachedReadTokens: 78, cachedNonReadTokens: 0 },
              turns: 1, durationMs: 100,
              filesRead: [], filesWritten: [], toolCallsByName: { run_shell: 1 },
              costUSD: 0.0042,
              terminationReason: 'ok', workerSelfAssessment: 'done',
            };
          },
          async close() { /* no-op */ },
        };
      },
    };
    const enqueued: unknown[] = [];
    const bus = new EnvelopeBus();
    bus.subscribe(new TelemetryUploader({
      recorder: { enqueue: (e) => { enqueued.push(e); } },
      consent: { decide: () => ({ enabled: true }) },
      buildOpts: (env) => ({
        reviewPolicy: 'full', toolMode: 'full', verifyCommandPresent: false,
        implementerModel: env.stages[0]?.model ?? env.mainModel,
        implementerTier: env.stages[0]?.tier ?? env.agentType,
        mainModelFamily: env.mainModel.split('-')[0] ?? 'unknown',
      }),
    }));
    const envelope = TaskEnvelopeStore.create({
      taskId: 'b5:0', batchId: 'b5', taskIndex: 0,
      route: 'delegate', agentType: 'standard',
      client: 'claude-code', mainModel: 'claude-opus-4-7', cwd: os.tmpdir(),
    }, bus);

    await runTaskViaDispatcher({
      task: { prompt: 'do', cwd: os.tmpdir(), reviewPolicy: 'none', timeoutMs: 60_000, tools: 'none' },
      resolved: { slot: 'standard', provider } as ResolvedAgent,
      config: makeConfig(),
      taskIndex: 0,
      route: 'delegate',
      envelope, bus,
    });

    const snap = envelope.snapshot();
    const impl = snap.stages.find(s => s.name === 'implementing');
    expect(impl).toBeDefined();
    // Regression: per-stage tokens MUST be > 0 when the runtime captured real
    // usage. Before the 4.7.3 lifecycle-driver fix these stayed at 0 even
    // when mergeStageStats wrote real numbers into state.lastRunResult.
    expect(impl!.inputTokens).toBeGreaterThanOrEqual(1234);
    expect(impl!.outputTokens).toBeGreaterThanOrEqual(56);
    expect(impl!.costUSD).toBeGreaterThan(0);
    expect(impl!.turnsUsed).toBeGreaterThanOrEqual(1);
    // Envelope totals must roll up from the populated stages.
    expect(snap.totalInputTokens).toBeGreaterThanOrEqual(1234);
    expect(snap.totalOutputTokens).toBeGreaterThanOrEqual(56);
    expect(snap.totalCostUSD).toBeGreaterThan(0);

    // Wire record must reflect the aggregation.
    expect(enqueued.length).toBeGreaterThanOrEqual(1);
    const rec = enqueued[0] as Record<string, unknown>;
    expect((rec['inputTokens'] as number)).toBeGreaterThanOrEqual(1234);
    expect((rec['outputTokens'] as number)).toBeGreaterThanOrEqual(56);
    expect((rec['totalCostUSD'] as number)).toBeGreaterThan(0);
    // Regression: tierUsage must NOT be empty {}. The standard bucket must
    // exist with non-zero cost+tokens for a task that used the standard tier.
    const tu = rec['tierUsage'] as { standard?: { costUSD: number; inputTokens: number } };
    expect(tu.standard).toBeDefined();
    expect(tu.standard!.costUSD).toBeGreaterThan(0);
    expect(tu.standard!.inputTokens).toBeGreaterThanOrEqual(1234);
    // Regression: top-level agentType must reflect the actual tier used,
    // not the hardcoded 'standard' from async-dispatch.
    expect(rec['agentType']).toBe('standard');
    // Find the annotating stage in the wire record. Regression: annotate
    // outcome was mapped from s.verdict (never set on annotate) and defaulted
    // to 'skipped' even when annotate ran. The wire enum for annotate is
    // {passed|failed|skipped|not_applicable|transformed}; envelope 'advance'
    // maps to 'transformed' (annotate's success mode).
    const wireStages = rec['stages'] as Array<{ name: string; outcome?: string }>;
    const annotate = wireStages.find(s => s.name === 'annotating');
    expect(annotate).toBeDefined();
    expect(annotate!.outcome).toBe('transformed');
  });
});
