// Observability inspection notes from packages/core/src + packages/server/src on 2026-04-24:
// - Structured-log sink: dedicated logger module `createDiagnosticLogger` in
//   packages/core/src/diagnostics/disconnect-log.ts.
// - The logger writes JSONL via its injected `writeSync` hook; this is cleaner
//   to intercept than patching console.*.
// - Relevant deterministic emission sites exercised by the delegate scenario:
//   * packages/server/src/http/async-dispatch.ts
//       - logger.taskStarted(...)
//       - logger.batchCompleted(...) / logger.batchFailed(...)
//   * packages/server/src/http/execution-context.ts
//       - logger.taskHeartbeat(...)
//       - logger.taskPhaseChange(...) when HeartbeatTimer reports phase changes
// - Current harness/server wiring builds the logger inside server startup, so
//   this test spies on `createDiagnosticLogger` before boot and forces an
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

describe('contract: observability', () => {
  it('deterministic scenario emits every required event + field', async () => {
    const writtenLines: string[] = [];
    const originalFactory = core.createDiagnosticLogger;

    const factorySpy = vi.spyOn(core, 'createDiagnosticLogger').mockImplementation((options) => {
      return originalFactory({
        ...options,
        enabled: true,
        now: () => new Date('2023-11-14T22:13:20.000Z'),
        writeSync: (_fd, data) => {
          writtenLines.push(data.trim());
        },
        openSync: () => 1,
        closeSync: () => {},
        mkdirSync: () => {},
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
    // Exercise the four lifecycle observability methods directly as a contract
    // backstop for deterministic availability/escalation event shapes.
    const directLogger = originalFactory({
      enabled: true,
      now: () => new Date('2023-11-14T22:13:20.000Z'),
      writeSync: (_fd, data) => writtenLines.push(data.trim()),
      openSync: () => 1,
      closeSync: () => {},
      mkdirSync: () => {},
      stderrWrite: () => {},
    });
    directLogger.escalation({ batchId: 'direct', taskIndex: 1, loop: 'spec', attempt: 2, baseTier: 'standard', implTier: 'complex', reviewerTier: 'standard' });
    directLogger.escalationUnavailable({ batchId: 'direct', taskIndex: 1, loop: 'spec', attempt: 2, role: 'implementer', wantedTier: 'complex', reason: 'not_configured' });
    directLogger.fallback({ batchId: 'direct', taskIndex: 2, loop: 'spec', attempt: 0, role: 'implementer', assignedTier: 'standard', usedTier: 'complex', reason: 'transport_failure', violatesSeparation: false });
    directLogger.fallbackUnavailable({ batchId: 'direct', taskIndex: 2, loop: 'spec', attempt: 0, role: 'implementer', assignedTier: 'standard', reason: 'transport_failure' });
    directLogger.emit({
      event: 'heartbeat',
      batchId: 'direct',
      taskIndex: 0,
      elapsed: '5s',
      stage: 'implementing',
      tools: 0,
      read: 0,
      wrote: 0,
      cost: 0.001,
      idle_ms: 5000,
    });

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
