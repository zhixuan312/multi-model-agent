// One-stop wiring that attaches each tool's handler builder to the
// ToolSurfaceRegistry after metadata registration. Called once at server
// startup by registerToolHandlers. Adding a new tool requires editing this
// file plus the new tool-config.ts + handler builder — nowhere else.

import type { ToolSurfaceRegistry } from '@zhixuan92/multi-model-agent-core';
import type { HandlerDeps } from '../handler-deps.js';
import type { RawHandler } from '../types.js';

export async function registerAllHandlers(registry: ToolSurfaceRegistry): Promise<void> {
  const { buildDelegateHandler } = await import('../handlers/tools/delegate.js');
  const { buildAuditHandler } = await import('../handlers/tools/audit.js');
  const { buildReviewHandler } = await import('../handlers/tools/review.js');
  const { buildVerifyHandler } = await import('../handlers/tools/verify.js');
  const { buildDebugHandler } = await import('../handlers/tools/debug.js');
  const { buildExecutePlanHandler } = await import('../handlers/tools/execute-plan.js');
  const { buildRetryHandler } = await import('../handlers/tools/retry.js');
  const { buildInvestigateHandler } = await import('../handlers/tools/investigate.js');
  const { buildExploreHandler } = await import('../handlers/tools/explore.js');

  registry.setHandler('delegate', (deps) => buildDelegateHandler(deps as HandlerDeps));
  registry.setHandler('audit', (deps) => buildAuditHandler(deps as HandlerDeps));
  registry.setHandler('review', (deps) => buildReviewHandler(deps as HandlerDeps));
  registry.setHandler('verify', (deps) => buildVerifyHandler(deps as HandlerDeps));
  registry.setHandler('debug', (deps) => buildDebugHandler(deps as HandlerDeps));
  registry.setHandler('execute_plan', (deps) => buildExecutePlanHandler(deps as HandlerDeps));
  registry.setHandler('retry_tasks', (deps) => buildRetryHandler(deps as HandlerDeps));
  registry.setHandler('investigate', (deps) => buildInvestigateHandler(deps as HandlerDeps));
  registry.setHandler('explore', (deps) => buildExploreHandler(deps as HandlerDeps));
}
