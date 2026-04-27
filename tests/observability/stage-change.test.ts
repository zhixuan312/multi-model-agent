import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { EventBus } from '../../packages/core/src/observability/bus.js';
import type { EventType } from '../../packages/core/src/observability/events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => {
  const impl = {
    output: '## Summary\ndone\n\n## Files changed\n- src/a.ts: updated\n\n## Normalization decisions\n\n## Validations run\n- tsc: passed\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok' as const,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 0.01 },
    turns: 3,
    filesRead: ['src/a.ts'],
    filesWritten: ['src/a.ts'],
    toolCalls: ['readFile(src/a.ts)', 'writeFile(src/a.ts)'],
    outputIsDiagnostic: false,
    escalationLog: [],
    briefQualityWarnings: [],
    retryable: false,
  };
  const review = {
    output: '## Summary\napproved\n\n## Deviations from brief\n\n## Unresolved\n',
    status: 'ok' as const,
    usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, costUSD: 0.005 },
    turns: 1,
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    outputIsDiagnostic: false,
    escalationLog: [],
    briefQualityWarnings: [],
    retryable: false,
  };
  return {
    createProvider: (slot: string) => ({
      name: slot,
      config: { type: 'openai-compatible' as const, model: `${slot}-model`, baseUrl: 'https://ex.invalid/v1' },
      run: async (prompt: string) => {
        if (typeof prompt === 'string' && prompt.startsWith('You are a spec compliance reviewer')) return review;
        if (typeof prompt === 'string' && prompt.startsWith('You are a code quality reviewer')) return review;
        return impl;
      },
    }),
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('// mock file content\nconst x = 1;\n'),
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

const config: MultiModelConfig = {
  agents: {
    standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
    complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
  },
  defaults: { timeoutMs: 600_000, tools: 'full' },
};

describe('stage_change emissions (P5)', () => {
  // Structural invariant: the heartbeat-tick branch in wrappedOnProgress must
  // not call emitTaskEvent('stage_change', ...). Stage transitions are
  // authoritative only via explicit emitTaskEvent calls at lifecycle points.
  it('heartbeat-tick handler does not emit stage_change', () => {
    const sourcePath = resolve(__dirname, '../../packages/core/src/run-tasks/reviewed-lifecycle.ts');
    const source = readFileSync(sourcePath, 'utf8');

    // Locate the heartbeat-tick branch and assert no stage_change emit inside it.
    const heartbeatBranchStart = source.indexOf("if (event.kind === 'heartbeat')");
    expect(heartbeatBranchStart).toBeGreaterThan(-1);

    // The branch is bounded by the next sibling kind-handler. Search forward
    // for the next `if (event.kind === ` sibling — the branch ends before it.
    const nextKindCheck = source.indexOf("if (event.kind === ", heartbeatBranchStart + 1);
    const branchEnd = nextKindCheck > 0 ? nextKindCheck : source.length;
    const branchBody = source.slice(heartbeatBranchStart, branchEnd);

    expect(branchBody).not.toMatch(/emitTaskEvent\(\s*['"]stage_change['"]/);
  });

  // Behavioral smoke check: drive a happy-path lifecycle and assert no
  // duplicate (from→to) stage_change pair is ever emitted. Even though the
  // happy path may emit zero stage_changes, this covers paths that emit one
  // or more without double-firing.
  it('emits each (from→to) stage_change at most once', async () => {
    const captured: EventType[] = [];
    const bus = new EventBus([{ name: 'capture', emit: (ev) => { captured.push(ev); } }]);

    await runTasks(
      [{ prompt: 'do the task at src/a.ts. Done when tsc passes.', agentType: 'standard' as const }],
      config,
      { batchId: '00000000-0000-0000-0000-000000000001', bus },
    );

    const stageChanges = captured.filter((e) => e.event === 'stage_change') as Array<EventType & { from: string; to: string }>;
    const seen = new Set<string>();
    for (const sc of stageChanges) {
      const key = `${sc.from}→${sc.to}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
