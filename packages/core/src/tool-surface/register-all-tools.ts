// One-stop registration for all tools' SurfaceEntry rows. Production
// boot (packages/server/src/http/server.ts) calls this once; the
// workflow-matrix contract test does the same. Adding a new tool means
// editing this file plus the new tool-config.ts, nowhere else.

import { ToolSurfaceRegistry } from './tool-surface-registry.js';
import { registerReview } from '../tools/review/tool-config.js';
import { registerDebug } from '../tools/debug/tool-config.js';
import { registerExecutePlan } from '../tools/execute-plan/tool-config.js';
import { registerRetry } from '../tools/retry/tool-config.js';
import { registerInvestigate } from '../tools/investigate/tool-config.js';
import { registerResearch } from '../tools/research/tool-config.js';
import { registerContextBlock } from '../tools/register-context-block/tool-config.js';
import { registerJournalRecord } from '../tools/journal/record/tool-config.js';
import { registerJournalRecall } from '../tools/journal/recall/tool-config.js';

export function registerAllTools(registry: ToolSurfaceRegistry): void {
  registerReview(registry);
  registerDebug(registry);
  registerExecutePlan(registry);
  registerRetry(registry);
  registerInvestigate(registry);
  registerResearch(registry);
  registerContextBlock(registry);
  registerJournalRecord(registry);
  registerJournalRecall(registry);
}

export function buildToolSurfaceRegistry(): ToolSurfaceRegistry {
  const registry = new ToolSurfaceRegistry();
  registerAllTools(registry);
  return registry;
}
