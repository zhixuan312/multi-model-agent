import { describe, it, expect } from 'vitest';
import { LifecycleDriver } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';
import { TaskExecutor } from '../../packages/core/src/lifecycle/handlers/task-executor.js';
import { DeriveTerminalStatusHandler } from '../../packages/core/src/lifecycle/handlers/derive-terminal-status.js';
import { TerminalStatusDeriver } from '../../packages/core/src/reporting/terminal-status-deriver.js';
import { ShutdownCoordinator } from '../../packages/core/src/cleanup/shutdown-coordinator.js';
import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';

describe('Phase-4 end-to-end LifecycleDriver fixture', () => {
  it('drives one task through Stages 1-6 with no review and reaches complete status', async () => {
    const emitter = new EventEmitter();
    const executor = new TaskExecutor(emitter);
    const deriver = new TerminalStatusDeriver();
    const coord = new ShutdownCoordinator();
    const terminalHandler = new DeriveTerminalStatusHandler(deriver, coord);

    const plan = buildStagePlan('artifact_producing');

    const noop = () => undefined;
    const handlers: Record<string, (s: any) => void> = {
      accept_http_request: noop,
      verify_loopback: noop,
      validate_workspace: noop,
      load_project_state: noop,
      prepare_execution_context: () => { /* test injects executionContext below */ },

      parse_brief: noop,
      verify_referenced_blocks: noop,
      apply_defaults: noop,
      mark_intake_complete: noop,

      run_initial_impl: executor.handler,
      check_files_written: noop,

      spec_review_round_1: noop,
      rework_for_spec_round_1: noop,
      spec_review_round_2: noop,
      rework_for_spec_round_2: noop,
      spec_review_round_3: noop,
      settle_spec_chain: (s: any) => { s.specChainPassed = true; },
      quality_review_round_1: noop,
      rework_for_quality_round_1: noop,
      quality_review_round_2: noop,
      rework_for_quality_round_2: noop,
      quality_review_round_3: noop,
      settle_quality_chain: (s: any) => { s.qualityChainPassed = true; },
      review_diff: noop,

      run_verify_command: noop,
      git_commit: noop,
      compose_response: terminalHandler.handler,
      register_terminal_block: noop,
      emit_task_terminal: noop,
      persist_to_batch_registry: noop,
      record_task_completed: noop,

      flush_telemetry: noop,
      project_idle_cleanup_tick: noop,
      batch_retention_sweep_tick: noop,
    };

    const driver = new LifecycleDriver(plan, handlers);

    const fakeSession = {
      async send() {
        return {
          output: 'done\n\n```json\n{"summary":"done","workerStatus":"done","filesChanged":[],"validationsRun":[],"unresolved":[]}\n```',
          usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
          filesRead: [],
          filesWritten: [],
          toolCallsByName: {},
          turns: 1,
          durationMs: 1,
          costUSD: 0,
          terminationReason: 'ok' as const,
        };
      },
      async close() { /* no-op */ },
    };
    const state: any = {
      terminal: false,
      attemptIndex: 0,
      attemptBudget: 7,
      reviewPolicy: 'none',
      shutdownInProgress: false,
      cwd: process.cwd(),
      systemPrompt: 'sys',
      userMessage: 'do nothing',
      maxTurns: 1,
      taskIndex: 0,
      reviewVerdict: 'approved',
      executionContext: {
        assignedTier: 'standard',
        getSession: () => fakeSession,
        wallClockGuard: { checkOrThrow: () => undefined },
        closeSessions: async () => undefined,
      },
    };

    const final = await driver.run(state);

    expect(final.terminalStatus).toBe('ok');
    expect(final.workerStatus).toBe('done');
  });
});
