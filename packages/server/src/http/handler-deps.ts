// packages/server/src/http/handler-deps.ts
import type { ExecutionRegistry } from '@zhixuan92/multi-model-agent-core';
import type { ExecutionRuntime } from '../application/execution-runtime.js';
import type { ExecutionStore } from '../application/execution-store.js';
import type { InitiativeRecordRuntime } from '../application/initiative-record-runtime.js';

/**
 * Dependencies injected into the unified execution handler factories at server
 * startup. The POST and DELETE handlers need the application runtime; the poll
 * handler reads the in-memory ExecutionRegistry first and falls back to the durable
 * ExecutionStore for terminal results that survived a restart or registry
 * eviction. `initiativeRuntime` is the shared Initiative Record application
 * service the `/initiatives` HTTP adapter (and, later, the MCP adapter) call
 * into — a separate store/lifecycle from `store` above.
 *
 * An `initiativeLinker` field sat here too, with a comment conceding "no handler calls it
 * directly today, but it is carried here alongside its sibling application services for
 * introspection/testing". No handler ever did, and no test read it either — it was assigned in
 * `server.ts` and never touched again. The linker IS live; it just does not arrive this way:
 * `ExecutionRuntime` takes it as its own dependency and calls `replayOutbox()` after each
 * terminal write, and `reconcileOnBoot` takes it directly. Carrying an unread copy alongside
 * them only invited a future handler to reach for the wrong one.
 */
export interface HandlerDeps {
  runtime: ExecutionRuntime;
  executionRegistry: ExecutionRegistry;
  store: ExecutionStore;
  initiativeRuntime: InitiativeRecordRuntime;
}
