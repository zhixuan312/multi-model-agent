import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MultiModelConfig, Provider } from '@zhixuan92/multi-model-agent-core';
import { runTasks } from '@zhixuan92/multi-model-agent-core/lifecycle/task-runner';
import { EventSchemas } from '../../../packages/core/src/events/observability-events.js';
import { EventEmitter, type EventSink } from '../../../packages/core/src/events/event-emitter.js';

const BATCH_ID = '00000000-0000-4000-8000-000000000001';
const TS = '2026-05-02T00:00:00.000Z';

type EventFactory = () => Record<string, unknown>;

const factories: Record<string, EventFactory> = {
  task_started: () => ({ event: 'task_started', ts: TS, batchId: BATCH_ID, taskIndex: 0, route: 'delegate', cwd: '/tmp/test' }),
  stage_change: () => ({ event: 'stage_change', ts: TS, batchId: BATCH_ID, taskIndex: 0, from: 'implementing', to: 'review', attempt: 1, attemptCap: 3, implTier: 'standard', reviewerTier: 'standard', escalated: false }),
  heartbeat: () => ({ event: 'heartbeat', ts: TS, batchId: BATCH_ID, taskIndex: 0, elapsed: '30s', stage: 'implementing', round: 1, cap: 3, tools: 5, read: 3, wrote: 2, text: 1500, cost: 0.005, idle_ms: 2000, stage_idle_ms: 1000 }),
  fallback: () => ({ event: 'fallback', ts: TS, batchId: BATCH_ID, taskIndex: 0, loop: 'spec', attempt: 2, role: 'implementer', assignedTier: 'standard', usedTier: 'complex', reason: 'not_configured', triggeringStatus: 'api_error', violatesSeparation: false, fallbackSeparationRespected: true, assignedIdentity: { providerType: 'claude', normalizedEndpoint: 'https://api.anthropic.com', modelId: 'claude-sonnet' }, usedIdentity: { providerType: 'codex', normalizedEndpoint: 'https://api.openai.com', modelId: 'gpt-4o' } }),
  fallback_unavailable: () => ({ event: 'fallback_unavailable', ts: TS, batchId: BATCH_ID, taskIndex: 0, loop: 'quality', attempt: 1, role: 'qualityReviewer', assignedTier: 'standard', reason: 'not_configured' }),
  escalation: () => ({ event: 'escalation', ts: TS, batchId: BATCH_ID, taskIndex: 0, loop: 'spec', attempt: 1, baseTier: 'standard', implTier: 'complex', reviewerTier: 'complex' }),
  escalation_unavailable: () => ({ event: 'escalation_unavailable', ts: TS, batchId: BATCH_ID, taskIndex: 0, loop: 'quality', attempt: 2, role: 'qualityReviewer', wantedTier: 'complex', reason: 'not_configured' }),
  review_decision: () => ({ event: 'review_decision', ts: TS, batchId: BATCH_ID, taskIndex: 0, stage: 'spec', verdict: 'approved', round: 1 }),
  verify_step: () => ({ event: 'verify_step', ts: TS, batchId: BATCH_ID, taskIndex: 0, command: 'npm test', status: 'passed', exitCode: 0, durationMs: 5000 }),
  verify_skipped: () => ({ event: 'verify_skipped', ts: TS, batchId: BATCH_ID, taskIndex: 0, reason: 'no_command', stage: 'annotating' }),
  'read_only_review.quality': () => ({ event: 'read_only_review.quality', ts: TS, batchId: BATCH_ID, taskIndex: 0, route: 'delegate', verdict: 'approved', iterationIndex: 1, findingsReviewed: 3, meanConfidence: 85.5, durationMs: 3000, costUSD: 0.002 }),
  'read_only_review.terminal': () => ({ event: 'read_only_review.terminal', ts: TS, batchId: BATCH_ID, taskIndex: 0, route: 'delegate', roundsUsed: 2, finalQualityVerdict: 'approved', costUSD: 0.005, durationMs: 8000 }),
  stall_abort: () => ({ event: 'stall_abort', ts: TS, batchId: BATCH_ID, taskIndex: 0, idle_ms: 60000, threshold_ms: 30000 }),
  time_check: () => ({ event: 'time_check', ts: TS, batchId: BATCH_ID, taskIndex: 0, stage: 'rework', tripped: true, wallClockMs: 50_000, timeoutMs: 60_000 }),
  task_completed: () => ({ event: 'task_completed', ts: TS, batchId: BATCH_ID, taskIndex: 0, status: 'ok', workerStatus: 'done', turns: 3, durationMs: 25000, filesRead: 5, filesWritten: 2, toolCalls: 7, inputTokens: 500, outputTokens: 250, cachedReadTokens: 80, cachedNonReadTokens: 70, costUSD: 0.005, taskMaxIdleMs: 5000, stallTriggered: false, stages: JSON.stringify({}) }),
  batch_completed: () => ({ event: 'batch_completed', ts: TS, batchId: BATCH_ID, tool: 'delegate', durationMs: 30000, taskCount: 3 }),
  batch_failed: () => ({ event: 'batch_failed', ts: TS, batchId: BATCH_ID, tool: 'delegate', durationMs: 5000, errorCode: 'all_tasks_failed', errorMessage: 'All 3 tasks failed with api_error' }),
  worker_start: () => ({ event: 'worker_start', ts: TS, batchId: BATCH_ID, taskIndex: 0, model: 'claude-sonnet', providerType: 'claude', tier: 'standard' }),
  turn_start: () => ({ event: 'turn_start', ts: TS, batchId: BATCH_ID, taskIndex: 0, turnIndex: 0, providerType: 'claude', model: 'claude-sonnet' }),
  turn_complete: () => ({ event: 'turn_complete', ts: TS, batchId: BATCH_ID, taskIndex: 0, turnIndex: 0, inputTokens: 500, outputTokens: 250, cachedReadTokens: 80, cachedNonReadTokens: 70, costUSD: 0.005, durationMs: 3000, providerType: 'claude', model: 'claude-sonnet' }),
  tool_call: () => ({ event: 'tool_call', ts: TS, batchId: BATCH_ID, taskIndex: 0, tool: 'read_file', turnIndex: 0 }),
  text_emission: () => ({ event: 'text_emission', ts: TS, batchId: BATCH_ID, taskIndex: 0, chars: 500, turnIndex: 0 }),
  'task.completed': () => ({ event: 'task.completed', ts: TS, route: 'delegate', agentType: 'standard', capabilities: ['web_search', 'web_fetch'], toolMode: 'full', client: 'claude-code', fileCountBucket: '1-5', durationBucket: '10s-1m', costBucket: '<$0.01', savedCostBucket: '$0', implementerModelFamily: 'claude', implementerModel: 'claude-sonnet', terminalStatus: 'ok', workerStatus: 'done', errorCode: null, escalated: false, fallbackTriggered: false, topToolNames: ['read_file', 'edit_file'], stages: {} }),
  'session.started': () => ({ event: 'session.started', ts: TS, configFlavor: { server: { port: 7337 } }, providersConfigured: ['claude', 'codex'] }),
  'install.changed': () => ({ event: 'install.changed', ts: TS, fromVersion: '3.10.0', toVersion: '3.11.0', trigger: 'upgrade' }),
  'skill.installed': () => ({ event: 'skill.installed', ts: TS, skill: 'mma-delegate', client: 'claude-code' }),
};

export function buildEvent(eventName: string): Record<string, unknown> {
  const factory = factories[eventName];
  if (!factory) throw new Error(`No fixture factory registered for event "${eventName}". Add one to tests/telemetry/fixtures/event-matrix.ts.`);
  return factory();
}

export function getFixtureEventNames(): Set<string> {
  return new Set(Object.keys(factories));
}

function configFor(provider: Provider): MultiModelConfig {
  return {
    agents: {
      standard: { type: 'codex', model: 'std', baseUrl: 'https://ex.invalid/v1' },
      complex: { type: 'codex', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, sandboxPolicy: 'cwd-only' },
    server: {} as any,
  };
}

export async function runCanonicalRuntimeFixtureAndCaptureEvents(provider: Provider): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const sink: EventSink = { name: 'capture', emit(event) { events.push(structuredClone(event as Record<string, unknown>)); } };
  const bus = new EventEmitter([sink]);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mma-telemetry-fixture-')));

  await runTasks(
    [{ prompt: 'implement a tiny change. done when complete.', agentType: 'standard', cwd, reviewPolicy: 'none' } as any],
    configFor(provider),
    { batchId: randomUUID(), bus, route: 'delegate' },
  );

  return events;
}

export async function runFixtureMatrixAndCaptureEvents(provider?: Provider): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  if (provider) events.push(...await runCanonicalRuntimeFixtureAndCaptureEvents(provider));
  for (const eventName of Object.keys(factories)) {
    if (!events.some(e => e.event === eventName)) events.push(factories[eventName]());
  }
  return events;
}

export function syntheticFixtureEvents(): Record<string, unknown>[] {
  return Object.keys(factories).map((eventName) => factories[eventName]());
}

export function assertAllFactoriesMatchSchemas(): void {
  for (const event of syntheticFixtureEvents()) {
    const eventName = event.event as string;
    const schema = EventSchemas[eventName];
    if (!schema) throw new Error(`${eventName}: no schema registered`);
    const result = schema.safeParse(event);
    if (!result.success) throw new Error(`${eventName}: ${JSON.stringify(result.error.format())}`);
  }
}
