import { describe, it, expect } from 'vitest';
import { mockAdapter } from '../contract/fixtures/mock-providers.js';
import { RunnerShell } from '../../packages/core/src/providers/runner-shell.js';
import { LifecycleDriver } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import { buildStagePlan } from '../../packages/core/src/lifecycle/stage-plan-builder.js';
import { TaskExecutor } from '../../packages/core/src/lifecycle/handlers/task-executor.js';
import { ExecutionContextBuilder } from '../../packages/core/src/lifecycle/handlers/execution-context-builder.js';
import { DeriveTerminalStatusHandler } from '../../packages/core/src/lifecycle/handlers/derive-terminal-status.js';
import { TerminalStatusDeriver } from '../../packages/core/src/reporting/terminal-status-deriver.js';
import { ShutdownCoordinator } from '../../packages/core/src/cleanup/shutdown-coordinator.js';
import { EventEmitter } from '../../packages/core/src/events/event-emitter.js';

describe('Phase-4 end-to-end LifecycleDriver fixture', () => {
  it('drives one task through Stages 1-6 with no review and reaches complete status', async () => {
    const shell = new RunnerShell(mockAdapter({
      turns: [{ assistantText: 'done', toolCalls: [] }],
      usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
    }));
    const emitter = new EventEmitter();
    const ctxBuilder = new ExecutionContextBuilder();
    const executor = new TaskExecutor(shell, emitter);
    const deriver = new TerminalStatusDeriver();
    const coord = new ShutdownCoordinator();
    const terminalHandler = new DeriveTerminalStatusHandler(deriver, coord);

    const plan = buildStagePlan('artifact_producing');

    const noop = () => undefined;
    const handlers: Record<string, (s: any) => void> = {
      // Stage 1 (1.1–1.5)
      accept_http_request: noop,
      verify_loopback: noop,
      validate_workspace: noop,
      load_project_state: noop,
      prepare_execution_context: ctxBuilder.handler,

      // Stage 2 (2.1–2.4)
      parse_brief: noop,
      verify_referenced_blocks: noop,
      apply_defaults: noop,
      mark_intake_complete: noop,

      // Stage 3
      run_initial_impl: executor.handler,
      check_files_written: noop,

      // Stage 4 — review chains (all no-op for reviewPolicy='none'; predicates skip)
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

      // Stage 5 (5.1–5.5)
      run_verify_command: noop,
      git_commit: noop,
      compose_response: terminalHandler.handler,
      register_terminal_block: noop,
      emit_task_terminal: noop,
      persist_to_batch_registry: noop,
      record_task_completed: noop,

      // Stage 6 (timer-driven rows return false from runCondition)
      flush_telemetry: noop,
      project_idle_cleanup_tick: noop,
      batch_retention_sweep_tick: noop,
    };

    const driver = new LifecycleDriver(plan, handlers);

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
    };

    const final = await driver.run(state);

    expect(final.terminalStatus).toBe('ok');
    expect(final.workerStatus).toBe('done');
    // terminal is the LifecycleDriver short-circuit flag, not a result
    // status. DeriveTerminalStatusHandler deliberately does NOT set it
    // so rows 5.3.5–6.1 still fire. On the happy path it stays false.
  });
});
