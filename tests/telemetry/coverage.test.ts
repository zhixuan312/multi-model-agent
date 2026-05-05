import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { MultiModelConfig, Provider } from '@zhixuan92/multi-model-agent-core';
import { EventSchemas, CLOUD_EVENT_NAMES } from '../../packages/core/src/observability/events.js';
import { EventBus, type EventSink } from '../../packages/core/src/observability/bus.js';
import { LocalLogSink } from '../../packages/core/src/observability/local-log-sink.js';
import { TelemetrySink, type Recorder } from '../../packages/core/src/observability/telemetry-sink.js';
import { JsonlWriter } from '../../packages/core/src/diagnostics/jsonl-writer.js';
import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';
import {
  runFixtureMatrixAndCaptureEvents,
  runCanonicalRuntimeFixtureAndCaptureEvents,
  syntheticFixtureEvents,
} from './fixtures/event-matrix.js';

let activeProvider: Provider;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: () => activeProvider,
}));

const UNCOVERED_ALLOWLIST = new Set<string>([
  'task_completed', // emitted by reviewed-lifecycle on real provider paths; the fixture matrix here uses a streamlined runner that emits task_done_summary instead. Covered by tests/diagnostics/default-mode.test.ts.
  'fallback', // requires a tier-fallback scenario; covered by reviewed-execution fallback integration tests.
  'fallback_unavailable', // requires both tiers unavailable; covered by reviewed-execution fallback integration tests.
  'escalation', // requires review rework/escalation policy path; covered by reviewed-execution escalation tests.
  'escalation_unavailable', // requires escalated tier missing/unavailable; covered by reviewed-execution escalation tests.
  'review_decision', // emitted on review-enabled paths; canonical fixture uses reviewPolicy=none to stay focused and fast.
  'verify_step', // requires artifact-producing task with verify command; covered by verify-stage tests.
  'verify_skipped', // requires artifact-producing task with no verify command; covered by verify-stage tests.
  'read_only_review.quality', // requires quality_only route; covered by read-only-review telemetry tests.
  'read_only_review.terminal', // requires quality_only route; covered by read-only-review telemetry tests.
  'stall_abort', // requires watchdog timeout; covered by watchdog reviewed-execution tests.
  'time_check', // requires time ceiling trip; covered by time-ceiling tests.
  'cost_check', // requires cost ceiling trip; covered by cost-ceiling tests.
  'batch_completed', // batch-level executor event, outside single-task canonical runTasks fixture.
  'batch_failed', // batch-level executor event, outside single-task canonical runTasks fixture.
  'explore_parallel_start', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'explore_parallel_end', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'explore_internal_unavailable', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'explore_external_unavailable', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'explore_synthesize_start', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'explore_synthesize_end', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'explore_thread_started', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'explore_thread_completed', // explore executor batch-level event, outside single-task canonical runTasks fixture.
  'turn_start', // verbose-only runner internal event; schema example retained until runtime verbose fixture is added.
  'turn_complete', // verbose-only runner internal event; schema example retained until runtime verbose fixture is added.
  'tool_call', // verbose-only runner internal event; schema example retained until runtime verbose fixture is added.
  'text_emission', // verbose-only runner internal event; schema example retained until runtime verbose fixture is added.
  'task.completed', // cloud event is produced by telemetry recorder path, not EventBus local fixture.
  'session.started', // session/install/skill lifecycle occurs outside runTasks fixture.
  'install.changed', // install lifecycle occurs outside runTasks fixture.
  'skill.installed', // skill install lifecycle occurs outside runTasks fixture.
]);

const NON_SCHEMA_PRODUCTION_EVENTS = new Set([
  'heartbeat_timer', 'task_done_summary',
]);

function mockProvider(): Provider {
  return {
    name: 'standard',
    config: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' } as any,
    run: async () => ({
      output: '## Summary\ndone\n\n## Files changed\n\n## Normalization decisions\n\n## Validations run\n\n## Deviations from brief\n\n## Unresolved\n',
      status: 'ok' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.001, costDeltaVsParentUSD: null, cachedTokens: 0, reasoningTokens: 0 },
      turns: 1,
      filesRead: [],
      filesWritten: [],
      toolCalls: [],
      outputIsDiagnostic: false,
      escalationLog: [],
      retryable: false,
    }),
  } as Provider;
}

let runtimeEvents: Record<string, unknown>[];
let fixtureEvents: Record<string, unknown>[];

beforeAll(async () => {
  activeProvider = mockProvider();
  runtimeEvents = await runCanonicalRuntimeFixtureAndCaptureEvents(activeProvider);
  fixtureEvents = await runFixtureMatrixAndCaptureEvents(activeProvider);
});

describe('telemetry coverage invariant', () => {
  it('every schema-declared event is emitted by a runtime fixture (or allowlisted)', () => {
    const seen = new Set(runtimeEvents.map(e => e.event as string));
    const missing = Object.keys(EventSchemas).filter(name => !seen.has(name) && !UNCOVERED_ALLOWLIST.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Events declared in schema but not emitted by any runtime fixture: ${missing.join(', ')}. ` +
        `Either add a production-path fixture to runFixtureMatrixAndCaptureEvents(), or add it to UNCOVERED_ALLOWLIST with a reason.`,
      );
    }
  });

  for (const [eventName, schema] of Object.entries(EventSchemas)) {
    it(`${eventName} payload validates against its schema (when emitted)`, () => {
      for (const evt of fixtureEvents.filter(e => e.event === eventName)) {
        const result = schema.safeParse(evt);
        if (!result.success) throw new Error(`schema violation for ${eventName}: ${JSON.stringify(result.error.format())}`);
      }
    });

    it(`${eventName} fixture exists OR is allowlisted (no silent skip)`, () => {
      const seen = runtimeEvents.some(e => e.event === eventName);
      if (!seen && !UNCOVERED_ALLOWLIST.has(eventName)) {
        throw new Error(`${eventName} has no runtime fixture and is not in UNCOVERED_ALLOWLIST`);
      }
    });
  }
});

describe('schema example fixtures', () => {
  it('every synthetic fixture factory produces a schema-valid full envelope', () => {
    for (const fixture of syntheticFixtureEvents()) {
      const eventName = fixture.event as string;
      const schema = EventSchemas[eventName];
      expect(schema, `${eventName} has schema`).toBeDefined();
      const result = schema.safeParse(fixture);
      if (!result.success) throw new Error(`${eventName}: ${JSON.stringify(result.error.format())}`);
    }
  });
});

describe('EventBus emit-time validation', () => {
  const nullSink: EventSink = { name: 'null', emit() {} };

  it('throws on malformed known event in test mode', () => {
    const bus = new EventBus([nullSink]);
    expect(() => bus.emit({ event: 'task_started', ts: '2026-05-02T00:00:00.000Z', batchId: '00000000-0000-4000-8000-000000000001', taskIndex: 0, route: 'delegate' } as any)).toThrow(/emit-time schema violation/);
  });

  it('passes unknown diagnostic event names through without validation', () => {
    const emitted: Record<string, unknown>[] = [];
    const bus = new EventBus([{ name: 'recording', emit(event) { emitted.push(event as any); } }]);
    expect(() => bus.emit({ event: 'heartbeat_timer', arbitraryField: 42 } as any)).not.toThrow();
    expect(emitted[0].event).toBe('heartbeat_timer');
  });

  it('validates development mode and skips production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      expect(() => new EventBus([nullSink]).emit({ event: 'task_started' } as any)).toThrow(/emit-time schema violation/);
      process.env.NODE_ENV = 'production';
      expect(() => new EventBus([nullSink]).emit({ event: 'task_started' } as any)).not.toThrow();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

describe('emit-vs-persist round-trip parity', () => {
  it('emit-time payload matches persisted payload field-for-field for canonical runtime fixture', async () => {
    activeProvider = mockProvider();
    const emitted: Record<string, unknown>[] = [];
    const lines: string[] = [];
    let fd = 1;
    const writer = new JsonlWriter({ dir: '/tmp/mma-test-jsonl', openSync: () => fd++, writeSync: (_fd, data) => { lines.push(data); }, closeSync: () => {}, mkdirSync: () => {}, now: () => new Date('2026-05-02T00:00:00.000Z') });
    const captureSink: EventSink = { name: 'capture', emit(event) { emitted.push(structuredClone(event as Record<string, unknown>)); } };
    const bus = new EventBus([captureSink, new LocalLogSink(writer)]);
    const config: MultiModelConfig = { agents: { standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' }, complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' } }, defaults: { tools: 'readonly', timeoutMs: 60_000, sandboxPolicy: 'cwd-only' }, server: {} as any };

    await runTasks([{ prompt: 'do it. done when complete.', agentType: 'standard', cwd: process.cwd(), reviewPolicy: 'none' } as any], config, { batchId: '00000000-0000-4000-8000-000000000001', bus });

    const persisted = lines.map(line => JSON.parse(line.trim()));
    expect(persisted.length).toBe(emitted.length);
    for (let i = 0; i < emitted.length; i++) {
      for (const [k, v] of Object.entries(emitted[i])) expect(persisted[i][k]).toEqual(v);
      expect(Object.keys(persisted[i]).sort()).toEqual(Object.keys(emitted[i]).sort());
    }
  });
});

describe('TelemetrySink cloud-event filtering', () => {
  it('forwards only cloud-bound events to the recorder', () => {
    const enqueued: Record<string, unknown>[] = [];
    const recorder: Recorder = { enqueue(event) { enqueued.push(structuredClone(event)); } };
    const bus = new EventBus([new TelemetrySink(recorder)]);
    for (const fixture of syntheticFixtureEvents()) bus.emit(fixture as any);
    expect(enqueued.length).toBe(syntheticFixtureEvents().filter(e => CLOUD_EVENT_NAMES.has(e.event as any)).length);
    expect(enqueued.every(e => CLOUD_EVENT_NAMES.has(e.event as any))).toBe(true);
  });
});

describe('non-schema production event awareness', () => {
  it('documents which production events lack EventSchemas entries', () => {
    for (const name of NON_SCHEMA_PRODUCTION_EVENTS) expect(name in EventSchemas).toBe(false);
  });
});
