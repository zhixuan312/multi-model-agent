import { describe, it, expect } from 'vitest';
import { RouteDispatcher } from '../../packages/core/src/lifecycle/route-dispatcher.js';
import { LifecycleDriver } from '../../packages/core/src/lifecycle/lifecycle-driver.js';
import type { LifecycleState, StagePlan } from '../../packages/core/src/lifecycle/stage-plan-types.js';
import { ContextBlockNotFoundError } from '../../packages/core/src/stores/context-block-tool.js';

function minimalPlan(category: 'artifact_producing' | 'read_only' | 'research'): StagePlan {
  return {
    toolCategory: category,
    rows: [
      { rowId: '1.1', stageName: 'accept_http_request', runCondition: () => true, isRework: false, handlerKey: 'accept_http_request' },
      { rowId: '1.2', stageName: 'verify_loopback', runCondition: () => true, isRework: false, handlerKey: 'verify_loopback' },
    ],
  };
}

function driverWith(plan: StagePlan) {
  return (p: StagePlan, handlers: Record<string, (s: LifecycleState) => Promise<void>>) =>
    new LifecycleDriver(plan, handlers);
}

describe('RouteDispatcher', () => {
  it('returns 200 with responseEnvelope on success', async () => {
    const envelope = { result: 'done' };
    const handlers = {
      accept_http_request: async (s: LifecycleState) => { s.responseEnvelope = envelope; },
      verify_loopback: async () => {},
    };
    const dispatcher = new RouteDispatcher(handlers, driverWith(minimalPlan('artifact_producing')));

    const out = await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: {},
    });

    expect(out.status).toBe(200);
    expect(out.body).toEqual(envelope);
  });

  it('returns 400 on ContextBlockNotFoundError', async () => {
    const handlers = {
      accept_http_request: () => { throw new ContextBlockNotFoundError('ctx-missing-1'); },
      verify_loopback: async () => {},
    };
    const dispatcher = new RouteDispatcher(handlers, driverWith(minimalPlan('artifact_producing')));

    const out = await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: {},
    });

    expect(out.status).toBe(400);
    expect((out.body as any).error).toBe('missing_context_block');
    expect((out.body as any).missing).toEqual(['ctx-missing-1']);
  });

  it('re-throws unknown errors', async () => {
    const handlers = {
      accept_http_request: () => { throw new Error('boom'); },
      verify_loopback: async () => {},
    };
    const dispatcher = new RouteDispatcher(handlers, driverWith(minimalPlan('artifact_producing')));

    await expect(dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: {},
    })).rejects.toThrow('boom');
  });

  it('passes reviewPolicy from rawRequest into initial state', async () => {
    let captured: LifecycleState | undefined;
    const handlers = {
      accept_http_request: async (s) => { captured = s; },
      verify_loopback: async () => {},
    };
    const dispatcher = new RouteDispatcher(handlers, driverWith(minimalPlan('artifact_producing')));

    await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: { reviewPolicy: 'diff_only' },
    });

    expect(captured!.reviewPolicy).toBe('diff_only');
  });

  it('defaults reviewPolicy to full when not in rawRequest', async () => {
    let captured: LifecycleState | undefined;
    const handlers = {
      accept_http_request: async (s) => { captured = s; },
      verify_loopback: async () => {},
    };
    const dispatcher = new RouteDispatcher(handlers, driverWith(minimalPlan('artifact_producing')));

    await dispatcher.dispatch({
      route: 'delegate',
      toolCategory: 'artifact_producing',
      rawRequest: {},
    });

    expect(captured!.reviewPolicy).toBe('full');
  });

  it('sets attemptBudget from tool category', async () => {
    let captured: LifecycleState | undefined;
    const handlers = {
      accept_http_request: async (s) => { captured = s; },
      verify_loopback: async () => {},
    };
    const dispatcher = new RouteDispatcher(handlers, driverWith(minimalPlan('read_only')));

    await dispatcher.dispatch({ route: 'delegate', toolCategory: 'read_only', rawRequest: {} });
    expect(captured!.attemptBudget).toBe(2);
  });
});
