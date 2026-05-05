import { RouteDispatcher } from '../../packages/core/src/lifecycle/route-dispatcher.js';
import { RunnerShell } from '../../packages/core/src/runner-shell/shell.js';
import { ContextBlockStore, ContextBlockNotFoundError, InMemoryContextBlockStore } from '../../packages/core/src/context/context-block-store.js';
import { BatchRegistry } from '../../packages/core/src/batch-registry.js';
import { TaskExecutor } from '../../packages/core/src/lifecycle/handlers/task-executor.js';
import { ExecutionContextBuilder } from '../../packages/core/src/lifecycle/handlers/execution-context-builder.js';
import { DeriveTerminalStatusHandler } from '../../packages/core/src/lifecycle/handlers/derive-terminal-status.js';
import { TerminalStatusDeriver } from '../../packages/core/src/reporting/terminal-status-deriver.js';
import { ShutdownCoordinator } from '../../packages/core/src/lifecycle/sweepers/shutdown-coordinator.js';
import { EventEmitter } from '../../packages/core/src/channels/event-emitter.js';
import type { RunnerAdapter } from '../../packages/core/src/runner-shell/adapter.js';
import type { StageHandler } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState } from '../../packages/core/src/lifecycle/stage-plan-types.js';

// ---- intake handlers (local until source-side implementations land) ------

function makeIntakeValidator(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as Record<string, unknown> | undefined;
    if (!req || typeof req !== 'object') {
      state.terminal = true;
      state.errorCode = 'intake_brief_invalid';
      return;
    }
    // Per-tool tests override parse_brief with their own slot compiler.
    // The default validator only checks that the request is a valid object;
    // it does not enforce per-route shape constraints here.
  };
}

function makeIntakeVerifyBlocks(store: ContextBlockStore): StageHandler {
  return (state: LifecycleState): void => {
    const ids = (state as any).contextBlockIds as string[] | undefined;
    if (!ids || ids.length === 0) return;
    for (const id of ids) {
      if (!store.get(id)) throw new ContextBlockNotFoundError(id);
    }
  };
}

function makeIntakeApplyDefaults(): StageHandler {
  return (state: LifecycleState): void => {
    const req = state.request as Record<string, unknown> | undefined;
    if (!req) return;
    if (state.cwd === undefined && typeof req.cwd === 'string') {
      (state as any).cwd = req.cwd;
    }
    if ((state as any).cwd === undefined) {
      (state as any).cwd = process.cwd();
    }
    if (state.maxTurns === undefined) {
      state.maxTurns = (typeof req.maxTurns === 'number' && req.maxTurns > 0) ? req.maxTurns : 50;
    }
    if ((state as any).systemPrompt === undefined && typeof req.systemPrompt === 'string') {
      (state as any).systemPrompt = req.systemPrompt;
    }
    if ((state as any).systemPrompt === undefined) {
      (state as any).systemPrompt = '';
    }
    if (state.userMessage === undefined) {
      state.userMessage = (typeof req.userMessage === 'string') ? req.userMessage : '';
    }
  };
}

function makeIntakeMarkComplete(emitter: EventEmitter): StageHandler {
  return (_state: LifecycleState): void => {
    emitter.emit({ type: 'intake_complete' });
  };
}

// ---- chain-settle handlers -----------------------------------------------

function makeChainSettler(chain: 'spec' | 'quality'): StageHandler {
  return (state: LifecycleState): void => {
    if (chain === 'spec') {
      // Spec chain passed when every round that fired returned 'approved' (or none fired)
      const verdicts = [
        state.specReviewRound1Verdict,
        state.specReviewRound2Verdict,
        state.specReviewRound3Verdict,
      ].filter((v): v is NonNullable<typeof v> => v !== undefined);
      state.specChainPassed = verdicts.length === 0 || verdicts.every(v => v === 'approved');
    } else {
      // Quality chain passed for artifact-producing when every round returned 'approved' or 'annotated';
      // for read-only (annotator path) round1 verdict 'annotated' also counts as passed.
      const verdicts = [
        state.qualityReviewRound1Verdict,
        state.qualityReviewRound2Verdict,
        state.qualityReviewRound3Verdict,
      ].filter((v): v is NonNullable<typeof v> => v !== undefined);
      state.qualityChainPassed = verdicts.length === 0
        || verdicts.every(v => v === 'approved' || v === 'annotated');
    }
  };
}

// ---- public bootstrap API ------------------------------------------------

export interface BootstrapDeps {
  registry?: BatchRegistry;
  store?: ContextBlockStore;
}

export function bootstrapWithMockAdapter(adapter: RunnerAdapter, deps: BootstrapDeps = {}): RouteDispatcher & { overrideHandler(key: string, fn: StageHandler): void; shell: RunnerShell } {
  const registry = deps.registry ?? new BatchRegistry();
  const store = deps.store ?? new InMemoryContextBlockStore();
  const emitter = new EventEmitter();
  const shell = new RunnerShell(adapter);
  const ctxBuilder = new ExecutionContextBuilder();
  const executor = new TaskExecutor(shell, emitter);
  const deriver = new TerminalStatusDeriver();
  const coord = new ShutdownCoordinator();
  const terminalHandler = new DeriveTerminalStatusHandler(deriver, coord);
  const noop: StageHandler = () => undefined;

  const handlers: Record<string, StageHandler> = {
    // Stage 1 — ingress (noop: bootstrap is post-ingress)
    accept_http_request: noop,
    verify_loopback: noop,
    validate_workspace: noop,
    load_project_state: noop,
    prepare_execution_context: ctxBuilder.handler.bind(ctxBuilder),

    // Stage 2 — intake (real handlers, not noops)
    parse_brief: makeIntakeValidator(),
    verify_referenced_blocks: makeIntakeVerifyBlocks(store),
    apply_defaults: makeIntakeApplyDefaults(),
    mark_intake_complete: makeIntakeMarkComplete(emitter),

    // Stage 3 — initial run
    run_initial_impl: executor.handler.bind(executor),

    // Stage 4 — review (noop by default; per-tool tests override as needed)
    spec_review_round_1: noop,
    rework_for_spec_round_1: noop,
    spec_review_round_2: noop,
    rework_for_spec_round_2: noop,
    spec_review_round_3: noop,
    settle_spec_chain: makeChainSettler('spec'),
    quality_review_round_1: noop,
    rework_for_quality_round_1: noop,
    quality_review_round_2: noop,
    rework_for_quality_round_2: noop,
    quality_review_round_3: noop,
    settle_quality_chain: makeChainSettler('quality'),
    review_diff: noop,

    // Stage 5 — finalize
    run_verify_command: noop,
    git_commit: noop,
    compose_response: (state: LifecycleState): void => {
      terminalHandler.handler.bind(terminalHandler)(state);
      const lastResult = state.lastRunResult as { finalAssistantText?: string; toolCalls?: unknown[]; workerStatus?: string; errorCode?: string } | undefined;
      const workerOutput = lastResult?.finalAssistantText ?? '';
      let structuredReport: unknown = null;
      const m = workerOutput.match(/```json\n([\s\S]+?)\n```/);
      if (m) {
        try { structuredReport = JSON.parse(m[1]); } catch { /* leave null */ }
      }
      (state as any).responseEnvelope = [{
        terminalStatus: state.terminalStatus ?? 'error',
        structuredReport,
        workerStatus: lastResult?.workerStatus,
        errorCode: lastResult?.errorCode,
      }];
    },
    register_terminal_block: noop,
    emit_task_terminal: noop,
    persist_to_batch_registry: noop,

    // Stage 6 — telemetry/cleanup (timer-driven; never fires from per-request loop)
    flush_telemetry: noop,
    project_idle_cleanup_tick: noop,
    batch_retention_sweep_tick: noop,
  };

  return Object.assign(new RouteDispatcher(handlers), {
    overrideHandler(key: string, fn: StageHandler) { handlers[key] = fn; },
    shell,
  });
}

export function bootstrapWithMockAdapterAndOverrides(
  adapter: RunnerAdapter,
  overrides: Partial<Record<string, StageHandler>> = {},
  deps: BootstrapDeps = {},
): RouteDispatcher & { overrideHandler(key: string, fn: StageHandler): void; shell: RunnerShell } {
  const dispatcher = bootstrapWithMockAdapter(adapter, deps);
  for (const [k, fn] of Object.entries(overrides)) {
    if (fn) dispatcher.overrideHandler(k, fn);
  }
  return dispatcher;
}

export function bootstrapWithMockAdapterAndRegistry(
  adapter: RunnerAdapter,
  registry: BatchRegistry,
  store: ContextBlockStore,
): RouteDispatcher & { overrideHandler(key: string, fn: StageHandler): void; shell: RunnerShell } {
  return bootstrapWithMockAdapter(adapter, { registry, store });
}
