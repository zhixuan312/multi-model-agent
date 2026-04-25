import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MultiModelConfig, Provider } from '@zhixuan92/multi-model-agent-core';
import {
  mockProvider,
  capExhaustingProvider,
  clarificationProvider,
  throwingProvider,
} from '../contract/fixtures/mock-providers.js';

let activeProvider: Provider;

vi.mock('@zhixuan92/multi-model-agent-core/provider', () => ({
  createProvider: () => activeProvider,
}));

import { runTasks } from '@zhixuan92/multi-model-agent-core/run-tasks';

function makeConfig(provider: Provider): MultiModelConfig {
  activeProvider = provider;
  return {
    agents: {
      standard: { type: 'openai-compatible', model: 'std', baseUrl: 'https://ex.invalid/v1' },
      complex: { type: 'openai-compatible', model: 'cpx', baseUrl: 'https://ex2.invalid/v1' },
    },
    defaults: { tools: 'readonly', timeoutMs: 60_000, maxCostUSD: 1, sandboxPolicy: 'cwd-only' },
    server: {} as any,
  };
}

function makeCwd(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'lc-sig-')));
}

describe('lifecycle propagates cap / clarification / worker-error signals', () => {
  it('turn cap with parseable output → result.capExhausted=turn, result.workerError=undefined', async () => {
    const cwd = makeCwd();
    const config = makeConfig(capExhaustingProvider({ kind: 'turn', partialOutput: '## Summary\npartial\n' }));
    const [result] = await runTasks(
      [{ prompt: 'go', agentType: 'standard', cwd, reviewPolicy: 'off' } as any],
      config,
    );
    expect(result.capExhausted).toBe('turn');
    expect(result.workerError).toBeUndefined();
    expect(result.output).toContain('partial');
  });

  it('cost cap propagates as capExhausted=cost', async () => {
    const cwd = makeCwd();
    const config = makeConfig(capExhaustingProvider({ kind: 'cost', partialOutput: '## Summary\nx\n' }));
    const [result] = await runTasks(
      [{ prompt: 'go', agentType: 'standard', cwd, reviewPolicy: 'off' } as any],
      config,
    );
    expect(result.capExhausted).toBe('cost');
  });

  it('wall_clock cap propagates as capExhausted=wall_clock', async () => {
    const cwd = makeCwd();
    const config = makeConfig(capExhaustingProvider({ kind: 'wall_clock', partialOutput: '## Summary\nx\n' }));
    const [result] = await runTasks(
      [{ prompt: 'go', agentType: 'standard', cwd, reviewPolicy: 'off' } as any],
      config,
    );
    expect(result.capExhausted).toBe('wall_clock');
  });

  it('worker throws → result.workerError set, output empty', async () => {
    const cwd = makeCwd();
    const config = makeConfig(throwingProvider(new Error('runner crashed')));
    const [result] = await runTasks(
      [{ prompt: 'go', agentType: 'standard', cwd, reviewPolicy: 'off' } as any],
      config,
    );
    expect(result.workerError).toBeInstanceOf(Error);
    expect(result.workerError?.message).toBe('runner crashed');
    expect(result.output).toBe('');
  });

  it('clarification → result.lifecycleClarificationRequested=true, workerError=undefined', async () => {
    const cwd = makeCwd();
    const config = makeConfig(clarificationProvider({ proposedInterpretation: 'please clarify' }));
    const [result] = await runTasks(
      [{ prompt: 'go', agentType: 'standard', cwd, reviewPolicy: 'off' } as any],
      config,
    );
    expect(result.lifecycleClarificationRequested).toBe(true);
    expect(result.workerError).toBeUndefined();
    expect(result.capExhausted).toBeUndefined();
  });

  it('clean completion → all three signal fields undefined/false', async () => {
    const cwd = makeCwd();
    const config = makeConfig(mockProvider({ stage: 'ok', output: '## Summary\ndone\n' }));
    const [result] = await runTasks(
      [{ prompt: 'go', agentType: 'standard', cwd, reviewPolicy: 'off' } as any],
      config,
    );
    expect(result.capExhausted).toBeUndefined();
    expect(result.workerError).toBeUndefined();
    expect(result.lifecycleClarificationRequested).toBeFalsy();
  });
});
