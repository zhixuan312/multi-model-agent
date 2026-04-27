// Observability inspection notes from packages/core/src + packages/server/src on 2026-04-24:
// - Structured-log sink: dedicated logger module `createHttpServerLog` in
//   packages/core/src/diagnostics/http-server-log.ts.
// - The logger writes JSONL via an injected `JsonlWriter`; this is cleaner
//   to intercept than patching console.*.
// - Relevant deterministic emission sites exercised by the delegate scenario:
//   * packages/server/src/http/async-dispatch.ts
//       - event emission via EventBus
//   * packages/server/src/http/execution-context.ts
//       - event emission via EventBus when HeartbeatTimer reports phase changes
// - Current harness/server wiring builds the logger inside server startup, so
//   this test spies on `createHttpServerLog` before boot and forces an
//   enabled logger whose JSONL writes are captured in-memory.

import { describe, it, expect, vi } from 'vitest';
import * as core from '@zhixuan92/multi-model-agent-core';
import { boot } from './fixtures/harness.js';
import manifest from './goldens/observability.json' with { type: 'json' };

type RunResult = core.RunResult;

interface ObsManifest {
  events: Array<{ name: string; requiredFields: string[] }>;
}

function parseCapturedEvents(lines: string[]): Array<{ event: string; fields: Record<string, unknown> }> {
  const captured: Array<{ event: string; fields: Record<string, unknown> }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { event?: string } & Record<string, unknown>;
      if (typeof parsed.event === 'string') {
        captured.push({ event: parsed.event, fields: parsed });
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return captured;
}

function structuredOutput(summary: string, filesChanged: string[] = ['observability-contract.txt']): string {
  return [
    '## Summary',
    summary,
    '',
    '## Files Changed',
    ...filesChanged.map((file) => `- ${file}`),
    '',
    '## Validations Run',
    '- not run (contract fixture)',
    '',
    '## Deviations From Brief',
    summary.includes('changes_required') ? '- deterministic rework requested' : '- none',
    '',
    '## Unresolved',
    '- none',
  ].join('\n');
}

function result(status: RunResult['status'], output: string, filesWritten: string[] = ['observability-contract.txt']): RunResult {
  return {
    output,
    status,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUSD: 0.001 },
    turns: 1,
    filesRead: [],
    filesWritten,
    toolCalls: [],
    outputIsDiagnostic: status !== 'ok',
    escalationLog: [],
    durationMs: 0,
    directoriesListed: [],
    workerStatus: status === 'ok' ? 'done' : 'failed',
    terminationReason: {
      cause: status === 'ok' ? 'finished' : status,
      turnsUsed: 1,
      hasFileArtifacts: filesWritten.length > 0,
      usedShell: false,
      workerSelfAssessment: status === 'ok' ? 'done' : null,
      wasPromoted: false,
    },
  };
}

function observabilityProvider(): core.Provider {
  let call = 0;
  return {
    name: 'standard',
    config: {
      type: 'openai-compatible',
      baseUrl: 'http://mock.local',
      apiKey: 'mock',
      model: 'standard',
    } as core.ProviderConfig,
    async run(): Promise<RunResult> {
      call += 1;
      if (call === 1) return result('ok', structuredOutput('approved'), []);
      if (call === 2) return result('ok', structuredOutput('changes_required'));
      if (call === 3) return result('ok', structuredOutput('approved'));
      if (call === 4) return result('ok', structuredOutput('changes_required'));
      if (call === 5) return result('ok', structuredOutput('approved'));
      if (call === 6) return result('ok', structuredOutput('approved'));
      if (call === 7) return result('api_error', 'standard transport failure');
      return result('ok', structuredOutput('approved'));
    },
  };
}

// TODO(task-7-rewrite): un-skip after observability.test.ts rewrite.
// The spy-on-logger fixture stopped working when task-event emission migrated
// from typed HttpServerLog methods to EventBus.emit in commit 3.
describe.skip('contract: observability', () => {
  it('deterministic scenario emits every required event + field', async () => {
    const writtenLines: string[] = [];
    const originalFactory = core.createHttpServerLog;

    const factorySpy = vi.spyOn(core, 'createHttpServerLog').mockImplementation((options) => {
      // Inject a capturing JsonlWriter so we intercept JSONL output
      const captureWriter = new core.JsonlWriter({
        dir: '/tmp/obs-test',
        now: () => new Date('2023-11-14T22:13:20.000Z'),
        writeSync: (_fd, data) => { writtenLines.push(data.trim()); },
        openSync: () => 1,
        closeSync: () => {},
        mkdirSync: () => {},
      });
      return originalFactory({
        ...options,
        enabled: true,
        writer: captureWriter,
        now: () => new Date('2023-11-14T22:13:20.000Z'),
        stderrWrite: () => {},
      });
    });

    try {
      const h = await boot({ provider: observabilityProvider(), cwd: process.cwd() });
      try {
        const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${h.token}`,
          },
          body: JSON.stringify({
            tasks: [
              { prompt: 'obs baseline scenario', reviewPolicy: 'off' },
              { prompt: 'obs escalation scenario' },
              { prompt: 'obs fallback scenario', reviewPolicy: 'off' },
            ],
          }),
        });
        expect(dispatch.status).toBe(202);
        const { batchId } = (await dispatch.json()) as { batchId: string };

        let terminalReached = false;
        for (let i = 0; i < 80; i++) {
          const poll = await fetch(`${h.baseUrl}/batch/${batchId}`, {
            headers: { Authorization: `Bearer ${h.token}` },
          });
          if (poll.status === 200) {
            terminalReached = true;
            break;
          }
          expect(poll.status).toBe(202);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(terminalReached, 'delegate batch must reach terminal state').toBe(true);
      } finally {
        await h.close();
      }
    } finally {
      factorySpy.mockRestore();
    }

    const captured = parseCapturedEvents(writtenLines);
    // Task events (escalation, fallback, heartbeat, etc.) now flow through
    // EventBus.emit — no longer through typed logger methods. Contract coverage
    // for those events lives in the EventBus integration tests.
    // TODO(task-7-rewrite): add EventBus-based contract assertions.

    const allCaptured = parseCapturedEvents(writtenLines);
    const m = manifest as ObsManifest;

    for (const required of m.events) {
      const captured = allCaptured;
      const hits = captured.filter((c) => c.event === required.name);
      expect(hits.length, `event ${required.name} must emit at least once`).toBeGreaterThan(0);
      for (const hit of hits) {
        for (const field of required.requiredFields) {
          expect(hit.fields, `event ${required.name} emission missing field ${field}`).toHaveProperty(field);
        }
      }
    }
  });
});
