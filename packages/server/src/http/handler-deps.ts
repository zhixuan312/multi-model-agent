// packages/server/src/http/handler-deps.ts
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import type { EnvelopeBus } from '@zhixuan92/multi-model-agent-core/events/envelope-bus';
import type { LogWriter } from '@zhixuan92/multi-model-agent-core/events/log-writer';
import type { ProjectRegistry } from './project-registry.js';
import type { TaskRegistry } from '@zhixuan92/multi-model-agent-core';

/**
 * Dependencies injected into every handler factory at server startup.
 * Built once; passed to buildUnifiedTaskHandler and buildTaskPollHandler.
 */
export interface HandlerDeps {
  /** Full multi-model config (agents + defaults). May be undefined in unit tests. */
  config: MultiModelConfig;
  logWriter: LogWriter;
  /** EnvelopeBus for structured observability — emits envelope snapshots and plain log entries. */
  bus: EnvelopeBus;
  projectRegistry: ProjectRegistry;
  taskRegistry: TaskRegistry;
}
