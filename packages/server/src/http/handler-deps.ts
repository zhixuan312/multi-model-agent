// packages/server/src/http/handler-deps.ts
import type { TaskRegistry } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionRuntime } from '../application/execution-runtime.js';
import type { ExecutionStore } from '../application/execution-store.js';
import type { InitiativeRecordRuntime } from '../application/initiative-record-runtime.js';

/**
 * Dependencies injected into the unified task handler factories at server
 * startup. The POST and DELETE handlers need the application runtime; the poll
 * handler reads the in-memory TaskRegistry first and falls back to the durable
 * ExecutionStore for terminal results that survived a restart or registry
 * eviction. `initiativeRuntime` is the shared Initiative Record application
 * service the `/initiatives` HTTP adapter (and, later, the MCP adapter) call
 * into — a separate store/lifecycle from `store` above.
 */
export interface HandlerDeps {
  runtime: ExecutionRuntime;
  taskRegistry: TaskRegistry;
  store: ExecutionStore;
  initiativeRuntime: InitiativeRecordRuntime;
}
