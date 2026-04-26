import { describe, it, expect } from 'vitest';
import { executeReviewedLifecycle } from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider } from '../../packages/core/src/types.js';

function makeConfig(opts?: {
  standardCapabilities?: ('web_search' | 'web_fetch')[];
  complexCapabilities?: ('web_search' | 'web_fetch')[];
  defaultTools?: 'none' | 'readonly' | 'no-shell' | 'full';
}): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'openai-compatible',
        model: 'gpt-5',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
        capabilities: opts?.standardCapabilities,
      },
      complex: {
        type: 'openai-compatible',
        model: 'gpt-5.2',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
        capabilities: opts?.complexCapabilities,
      },
    },
    defaults: {
      timeoutMs: 300_000,
      stallTimeoutMs: 600_000,
      maxCostUSD: 10,
      tools: opts?.defaultTools ?? 'full',
      sandboxPolicy: 'cwd-only',
    },
    server: {
      bind: '127.0.0.1',
      port: 7337,
      auth: { tokenFile: '/tmp/mock-token' },
      limits: {
        maxBodyBytes: 1_000_000,
        batchTtlMs: 300_000,
        idleProjectTimeoutMs: 3_600_000,
        clarificationTimeoutMs: 300_000,
        projectCap: 10,
        maxBatchCacheSize: 10,
        maxContextBlockBytes: 100_000,
        maxContextBlocksPerProject: 10,
        shutdownDrainMs: 5_000,
      },
      autoUpdateSkills: false,
    },
  };
}

const noFilesProvider: Provider = mockProvider({
  stage: 'ok',
  output: 'done',
});

describe('RunResult.agents carries resolved capabilities + toolMode', () => {
  it('populates implementerCapabilities from agent config capabilities', async () => {
    const config = makeConfig({ standardCapabilities: ['web_search', 'web_fetch'] });
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: noFilesProvider.run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.agents?.implementerCapabilities).toEqual(
      expect.arrayContaining(['web_search']),
    );
    const allowed = new Set(['web_search', 'web_fetch']);
    for (const c of r.agents!.implementerCapabilities!) {
      expect(allowed.has(c)).toBe(true);
    }
  });

  it('populates implementerCapabilities from model profile when agent has no explicit capabilities', async () => {
    const config = makeConfig(); // no explicit capabilities on standard
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: noFilesProvider.run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    // gpt-5 model profile has capabilities: ['web_search']
    expect(r.agents?.implementerCapabilities).toBeDefined();
    expect(Array.isArray(r.agents!.implementerCapabilities)).toBe(true);
  });

  it('returns toolMode matching task.tools', async () => {
    const config = makeConfig();
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off', tools: 'readonly' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: noFilesProvider.run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.agents?.implementerToolMode).toBe('readonly');
  });

  it('returns toolMode from defaults when task.tools is unset', async () => {
    const config = makeConfig({ defaultTools: 'no-shell' });
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: noFilesProvider.run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.agents?.implementerToolMode).toBe('no-shell');
  });

  it('toolMode is one of the valid ToolMode values', async () => {
    const config = makeConfig();
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'standard',
      provider: {
        name: 'mock-standard',
        config: config.agents.standard,
        run: noFilesProvider.run,
      },
      capabilityOverride: false,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(['none', 'readonly', 'no-shell', 'full']).toContain(
      r.agents?.implementerToolMode,
    );
  });

  it('uses the resolved slot (not the requested slot) for capabilities when capabilityOverride is true', async () => {
    const config = makeConfig({
      standardCapabilities: [],
      complexCapabilities: ['web_search'],
    });
    const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
    // resolved.slot is 'complex' even though the task would normally request 'standard'
    const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
      slot: 'complex',
      provider: {
        name: 'mock-complex',
        config: config.agents.complex,
        run: noFilesProvider.run,
      },
      capabilityOverride: true,
    };

    const r = await executeReviewedLifecycle(task, resolved, config, 0);

    expect(r.agents?.implementerCapabilities).toEqual(['web_search']);
  });
});
