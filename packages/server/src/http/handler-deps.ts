// packages/server/src/http/handler-deps.ts
import type { TaskRegistry } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionRuntime } from '../application/execution-runtime.js';

/**
 * Dependencies injected into the unified task handler factories at server
 * startup. The POST handler needs only the application runtime; the poll
 * handler reads the shared TaskRegistry.
 */
export interface HandlerDeps {
  runtime: ExecutionRuntime;
  taskRegistry: TaskRegistry;
}
