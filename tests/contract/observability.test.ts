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
import { mockProvider } from './fixtures/mock-providers.js';
import manifest from './goldens/observability.json' with { type: 'json' };

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
      const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
      try {
        const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${process.cwd()}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${h.token}`,
          },
          body: JSON.stringify({ tasks: [{ prompt: 'obs scenario' }] }),
        });
        expect(dispatch.status).toBe(202);
        const { batchId } = (await dispatch.json()) as { batchId: string };

        let terminalReached = false;
        for (let i = 0; i < 30; i++) {
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
    const m = manifest as ObsManifest;

    for (const required of m.events) {
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
