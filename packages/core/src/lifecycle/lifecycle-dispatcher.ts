import { LifecycleDriver, type StageHandler } from './lifecycle-driver.js';
import type { StagePlan, LifecycleState } from './stage-plan-types.js';
import { buildStagePlan } from './stage-plan-builder.js';
import { buildStageHandlers, type RouteExecutor } from './handlers/baseline-handlers.js';
import type { ToolCategory } from '../escalation/escalation-policy.js';
import { ContextBlockNotFoundError } from '../stores/context-block-tool.js';
import { ATTEMPT_BUDGETS } from '../escalation/escalation-policy.js';

export interface DispatchInput {
  route: string;
  toolCategory: ToolCategory;
  rawRequest: unknown;
  /**
   * Per-call executor closure. Invoked by the run_initial_impl stage handler
   * with the same rawRequest. Returning a value populates state.executorResult,
   * which compose_response lifts into state.responseEnvelope.
   *
   * Server constructs this closure with route-specific options (e.g.
   * delegate's injectDefaults) and the resolved ExecutionContext.
   */
  executor?: RouteExecutor;
  /**
   * Tool-specific extras the handlers may need. Currently unused; reserved
   * so handlers can read context without an explicit slot per tool.
   */
  context?: Record<string, unknown>;
}

export interface DispatchOutput {
  status: number;
  body: unknown;
}

export type DriverFactory = (plan: StagePlan, handlers: Record<string, StageHandler>) => LifecycleDriver;

export class LifecycleDispatcher {
  constructor(
    handlers: Record<string, StageHandler> = {},
    private buildDriver: DriverFactory = (plan, handlers) => new LifecycleDriver(plan, handlers),
  ) {
    // Fill in baseline noops for any missing keys, but keep the SAME reference
    // the caller passed in. Test fixtures (bootstrap.ts) capture this reference
    // and mutate it via overrideHandler() — cloning would break that contract.
    const baseline = buildStageHandlers({});
    for (const key of Object.keys(baseline)) {
      if (!(key in handlers)) handlers[key] = baseline[key];
    }
    this.handlers = handlers;
  }

  private handlers: Record<string, StageHandler>;

  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    try {
      const plan = buildStagePlan(input.toolCategory);
      const driver = this.buildDriver(plan, this.handlers);
      const finalState = await driver.run(this.initialState(input));
      return { status: 200, body: finalState.responseEnvelope };
    } catch (e) {
      if (e instanceof ContextBlockNotFoundError) {
        return { status: 400, body: { error: 'missing_context_block', missing: [e.id] } };
      }
      throw e;
    }
  }

  private initialState(input: DispatchInput): LifecycleState {
    return {
      terminal: false,
      attemptIndex: 0,
      attemptBudget: ATTEMPT_BUDGETS[input.toolCategory],
      reviewPolicy: (input.rawRequest as { reviewPolicy?: 'full' | 'quality_only' | 'diff_only' | 'none' })?.reviewPolicy ?? 'full',
      shutdownInProgress: false,
      route: input.route,
      toolCategory: input.toolCategory,
      request: input.rawRequest,
      executor: input.executor,
      ...(input.context ?? {}),
      projectContext: input.context?.projectContext as LifecycleState['projectContext'],
    };
  }
}
