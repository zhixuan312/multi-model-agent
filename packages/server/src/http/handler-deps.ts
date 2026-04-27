// packages/server/src/http/handler-deps.ts
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import type { HttpServerLog } from '@zhixuan92/multi-model-agent-core';
import type { EventBus } from '@zhixuan92/multi-model-agent-core';
import type { ProjectRegistry } from './project-registry.js';
import type { BatchRegistry } from '@zhixuan92/multi-model-agent-core';

/**
 * Dependencies injected into every handler factory at server startup.
 * Built once; passed to buildDelegateHandler, buildAuditHandler, etc.
 */
export interface HandlerDeps {
  /** Full multi-model config (agents + defaults). May be undefined in unit tests. */
  config: MultiModelConfig;
  logger: HttpServerLog;
  /** EventBus for structured observability — dual-sink: local JSONL + cloud telemetry. */
  bus: EventBus;
  projectRegistry: ProjectRegistry;
  batchRegistry: BatchRegistry;
}
