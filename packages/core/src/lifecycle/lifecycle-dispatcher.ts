// v5 lifecycle dispatcher.
//
// Single dispatch path: walk STAGE_PLAN via runStagePlan, return the v5
// ComposePayload from gates['compose']. No more LifecycleDriver class, no
// more StagePlan rows, no more handlerKey map, no more executor closure.

import { runStagePlan } from './lifecycle-driver.js';
import { STAGE_PLAN } from './stage-plan-builder.js';
import type { LifecycleState } from './stage-plan-types.js';
import type { ToolCategory } from './tool-category.js';
import { ContextBlockNotFoundError } from '../stores/context-block-tool.js';
import type { ComposePayload } from './stage-io.js';

export interface DispatchInput {
  route: string;
  toolCategory: ToolCategory;
  rawRequest: unknown;
  /**
   * Tool-specific extras the handlers may need. Plumbed via state spread so
   * route-specific data (task, executionContext, projectContext) reaches
   * stage handlers.
   */
  context?: Record<string, unknown>;
}

export interface DispatchOutput {
  status: number;
  /** ComposePayload on 200; a route error object on 4xx (e.g. missing_context_block). */
  body: ComposePayload | { error: string; missing?: string[]; message?: string };
  /**
   * Final lifecycle state — exposed so task-runner.ts and other batch-level
   * orchestrators can read `state.lastRunResult` (the RuntimeRunResult
   * mirror) for downstream consumers (recorder, headline composer) that
   * still expect the legacy fat shape.
   */
  finalState?: LifecycleState;
}

export class LifecycleDispatcher {
  async dispatch(input: DispatchInput): Promise<DispatchOutput> {
    try {
      const finalState = await runStagePlan(STAGE_PLAN, this.initialState(input));
      const composeGate = finalState.gates?.['compose'];
      let body: DispatchOutput['body'];
      if (input.route === 'register-context-block') {
        // Register-context-block wire shape is the minimal { id } envelope,
        // NOT the full ComposePayload. Lift it from the compose payload's
        // blockId field (set by composeHandler from gates['register-block']).
        const rawBody = (composeGate?.outcome === 'advance' && composeGate.payload)
          ? composeGate.payload as ComposePayload
          : (finalState as { responseEnvelope?: ComposePayload }).responseEnvelope as ComposePayload;
        const envelope = (finalState as { responseEnvelope?: { id?: string; error?: string } }).responseEnvelope;
        if (envelope && typeof envelope === 'object' && 'id' in envelope) {
          body = envelope as { error: string; missing?: string[]; message?: string };
        } else if (envelope && typeof envelope === 'object' && 'error' in envelope) {
          body = envelope as { error: string; missing?: string[]; message?: string };
        } else if (rawBody?.blockId) {
          body = { error: '', message: '' } as never;            // placeholder, overridden below
          body = { id: rawBody.blockId } as unknown as DispatchOutput['body'];
        } else {
          body = rawBody;
        }
      } else {
        body = (composeGate?.outcome === 'advance' && composeGate.payload)
          ? composeGate.payload as ComposePayload
          : (finalState as { responseEnvelope?: ComposePayload }).responseEnvelope as ComposePayload;
      }
      return { status: 200, body, finalState };
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
      reviewPolicy: (input.rawRequest as { reviewPolicy?: 'reviewed' | 'none' })?.reviewPolicy ?? 'reviewed',
      shutdownInProgress: false,
      route: input.route,
      toolCategory: input.toolCategory,
      request: input.rawRequest,
      ...(input.context ?? {}),
      projectContext: input.context?.projectContext as LifecycleState['projectContext'],
    };
  }
}
