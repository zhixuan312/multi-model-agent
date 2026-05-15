// packages/server/src/http/handler-deps.ts
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import type { HttpServerLog } from '@zhixuan92/multi-model-agent-core';
import type { EventEmitter } from '@zhixuan92/multi-model-agent-core';
import type { LifecycleDispatcher } from '@zhixuan92/multi-model-agent-core';
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
  /** EventEmitter for structured observability — dual-sink: local JSONL + cloud telemetry. */
  bus: EventEmitter;
  projectRegistry: ProjectRegistry;
  batchRegistry: BatchRegistry;
  /** Optional LifecycleDispatcher for v4.0 lifecycle dispatch. When set, handlers use the new path. */
  routeDispatcher?: LifecycleDispatcher;
}
