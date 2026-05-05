import { LifecycleDriver, type StageHandler } from './lifecycle-driver.js';
import type { StagePlan, LifecycleState } from './stage-plan-types.js';
import { buildStagePlan } from './stage-plan-builder.js';
import type { ToolCategory } from '../routing/escalation-policy.js';
import { ContextBlockNotFoundError } from '../context/context-block-store.js';
import { ATTEMPT_BUDGETS } from '../routing/escalation-policy.js';

export interface DispatchInput {
  route: string;
  toolCategory: ToolCategory;
  rawRequest: unknown;
}

export interface DispatchOutput {
  status: number;
  body: unknown;
}

export type DriverFactory = (plan: StagePlan, handlers: Record<string, StageHandler>) => LifecycleDriver;

export class RouteDispatcher {
  constructor(
    private handlers: Record<string, StageHandler>,
    private buildDriver: DriverFactory = (plan, handlers) => new LifecycleDriver(plan, handlers),
  ) {}

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
      reviewPolicy: (input.rawRequest as any).reviewPolicy ?? 'full',
      shutdownInProgress: false,
      route: input.route,
      toolCategory: input.toolCategory,
      request: input.rawRequest,
    };
  }
}
