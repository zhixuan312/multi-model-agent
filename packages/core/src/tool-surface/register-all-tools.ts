// One-stop registration for all 10 tools' SurfaceEntry rows. Production
// boot (packages/server/src/http/server.ts) calls this once; the
// workflow-matrix contract test does the same. Adding a new tool means
// editing this file plus the new tool-config.ts, nowhere else.

import { ToolSurfaceRegistry } from './tool-surface-registry.js';
import { registerDelegate } from '../tools/delegate/tool-config.js';
import { registerAudit } from '../tools/audit/tool-config.js';
import { registerReview } from '../tools/review/tool-config.js';
import { registerVerify } from '../tools/verify/tool-config.js';
import { registerDebug } from '../tools/debug/tool-config.js';
import { registerExecutePlan } from '../tools/execute-plan/tool-config.js';
import { registerRetry } from '../tools/retry/tool-config.js';
import { registerInvestigate } from '../tools/investigate/tool-config.js';
import { registerExplore } from '../tools/explore/tool-config.js';
import { registerContextBlock } from '../tools/register-context-block/tool-config.js';

export function registerAllTools(registry: ToolSurfaceRegistry): void {
  registerDelegate(registry);
  registerAudit(registry);
  registerReview(registry);
  registerVerify(registry);
  registerDebug(registry);
  registerExecutePlan(registry);
  registerRetry(registry);
  registerInvestigate(registry);
  registerExplore(registry);
  registerContextBlock(registry);
}

export function buildToolSurfaceRegistry(): ToolSurfaceRegistry {
  const registry = new ToolSurfaceRegistry();
  registerAllTools(registry);
  return registry;
}
