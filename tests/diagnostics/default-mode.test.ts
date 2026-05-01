import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeReviewedLifecycle } from '../../packages/core/src/run-tasks/reviewed-lifecycle.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';
import type { MultiModelConfig, TaskSpec, AgentType, Provider } from '../../packages/core/src/types.js';

function initCleanRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'mma-defaultmode-'));
  execSync('git init -q && git config user.email t@e && git config user.name T && git config commit.gpgsign false', { cwd });
  writeFileSync(join(cwd, 'README.md'), '# fixture');
  execSync('git add . && git commit -q -m "init"', { cwd });
  return cwd;
}

function makeConfig(): MultiModelConfig {
  return {
    agents: {
      standard: {
        type: 'openai-compatible',
        model: 'gpt-5',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
      complex: {
        type: 'openai-compatible',
        model: 'gpt-5.2',
        baseUrl: 'http://mock.local',
        apiKey: 'mock',
      },
    },
    defaults: {
      timeoutMs: 300_000,
      stallTimeoutMs: 600_000,
      maxCostUSD: 10,
      tools: 'full',
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

interface CaptureOptions {
  verbose: boolean;
  heartbeatIntervalMs?: number;
  mockDelayMs?: number;
  taskCount?: number;
}

async function runReviewedLifecycleAndCaptureLines(opts: CaptureOptions): Promise<string[]> {
  const lines: string[] = [];
  const config = makeConfig();
  const task: TaskSpec = { prompt: 'test', reviewPolicy: 'off' };
  const resolved: { slot: AgentType; provider: Provider; capabilityOverride: boolean } = {
    slot: 'standard',
    provider: {
      name: 'mock-standard',
      config: config.agents.standard,
      run: mockProvider({
        stage: 'ok',
        output: 'done',
        delayMs: opts.mockDelayMs,
      }).run,
    },
    capabilityOverride: false,
  };

  const taskCount = opts.taskCount ?? 1;
  for (let i = 0; i < taskCount; i++) {
    await executeReviewedLifecycle(task, resolved, config, i, undefined, {
      batchId: '94fc50cc12345678',
    }, {
      verbose: opts.verbose,
      verboseStream: (line: string) => { lines.push(line); },
    });
  }

  return lines;
}

describe('reviewed-lifecycle default-mode stdout', () => {
  it('omits text_emission, turn_start, turn_complete, tool_call, heartbeat events', async () => {
    const lines = await runReviewedLifecycleAndCaptureLines({ verbose: false });
    const eventTypes = lines.map(l => l.match(/event=([a-z_.]+)/)?.[1]).filter(Boolean);
    for (const banned of ['text_emission', 'turn_start', 'turn_complete', 'tool_call', 'heartbeat', 'heartbeat_timer']) {
      expect(eventTypes).not.toContain(banned);
    }
  });

  it('emits stage_change, task_done_summary, and warnings only', async () => {
    const lines = await runReviewedLifecycleAndCaptureLines({ verbose: false });
    const eventTypes = new Set(lines.map(l => l.match(/event=([a-z_.]+)/)?.[1]).filter(Boolean));
    const allowed = new Set(['stage_change', 'task_done_summary', 'fallback', 'fallback_unavailable', 'escalation', 'escalation_unavailable', 'stall_abort', 'cost_check']);
    for (const e of eventTypes) expect(allowed).toContain(e);
  });

  it('emits one task_done_summary line per task with the canonical format', async () => {
    const lines = await runReviewedLifecycleAndCaptureLines({ verbose: false, taskCount: 2 });
    const summaries = lines.filter(l => l.includes('event=task_done_summary'));
    expect(summaries).toHaveLength(2);
    for (const s of summaries) {
      expect(s).toMatch(/done: \w+ in /);
      expect(s).toMatch(/reviews \[spec=\w+, quality=\w+\]/);
    }
  });

  it('verbose mode emits all events including heartbeat', async () => {
    const lines = await runReviewedLifecycleAndCaptureLines({
      verbose: true,
      heartbeatIntervalMs: 100,
      mockDelayMs: 500,
    });
    const eventTypes = new Set(lines.map(l => l.match(/event=([a-z_.]+)/)?.[1]).filter(Boolean));
    // With a direct mock provider, the runner does not emit tool_call /
    // turn_start / text_emission events because the mock returns a canned
    // RunResult. We verify that the heartbeat timer fires and that
    // task-level events appear.
    expect(eventTypes).toContain('heartbeat');
    expect(eventTypes).toContain('heartbeat_timer');
    expect(eventTypes).toContain('stage_change');
    expect(eventTypes).toContain('task_done_summary');
    expect(eventTypes).toContain('task_completed');
  });

  it('verbose-mode task_completed line contains stages_json= and not stages={', async () => {
    const lines = await runReviewedLifecycleAndCaptureLines({ verbose: true });
    const tc = lines.find(l => l.includes('event=task_completed'))!;
    expect(tc).toContain('stages_json=');
    expect(tc).not.toContain('stages={');
  });
});
