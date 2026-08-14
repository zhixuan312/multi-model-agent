// In-process HTTP harness for contract tests.
// Provider injection via MMA_TEST_PROVIDER_OVERRIDE env guard.

import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { MultiModelConfig, Provider } from '@zhixuan92/multi-model-agent-core';
import { __setCoreTestProviderOverride, __setCoreTestProviderOverrideMap } from '@zhixuan92/multi-model-agent-core';
import { startServer, type RunningServer } from '@zhixuan92/multi-model-agent/server';

import { freezeClock } from './deterministic-clock.js';

/** One `ExecutionStore` outbox row, as read directly off `<stateDir>/executions.db` by
 *  `HarnessHandle.unconsumedOutbox()` (SPEC-003 Task I-6) — read-only, test-assertion shape. */
export interface HarnessOutboxRow {
  executionId: string;
  consumedAt: number | null;
}

export interface HarnessHandle {
  baseUrl: string;
  token: string;
  /** The running server's already-public ExecutionRegistry. Exposed for contract tests that
   *  need to seed non-terminal state (e.g. a running headline) deterministically —
   *  deliberately NOT a production endpoint. */
  executionRegistry: RunningServer['executionRegistry'];
  /** Read-only list of `ExecutionStore` outbox rows with `consumed_at IS NULL` (SPEC-003 Task
   *  I-6), oldest first — for test assertions only. Opens its OWN short-lived SQLite connection
   *  to `<stateDir>/executions.db` (WAL mode, multi-reader safe) rather than reaching into the
   *  running server's own connection, which this module never gets a handle to. */
  unconsumedOutbox(): HarnessOutboxRow[];
  /** Total row count in `<stateDir>/executions.db`'s `executions` table (SPEC-003 B6 round-2
   *  defect A) — for asserting that a REJECTED linked admission (task_claim_conflict /
   *  invalid_task_transition / invalid_request) created no durable execution row at all. A
   *  rejected admission never receives an `executionId` (the HTTP response is a 400, not a
   *  202), so this counts rows rather than looking one up by id. Opens its own short-lived
   *  connection, mirroring `unconsumedOutbox()`. */
  executionRowCount(): number;
  /** Read-only full-table snapshot of `<stateDir>/initiatives.db` (SPEC-006 Task I-4) — for
   *  before/after deep-equal assertions that a rejected or no-op Initiative Record mutation
   *  left every table byte-for-byte unchanged (not just row counts). Opens its own short-lived
   *  `DatabaseSync` connection, mirroring `unconsumedOutbox()`/`executionRowCount()`. Returns
   *  `SELECT * FROM <table> ORDER BY rowid` for each of the nine Initiative Record tables,
   *  keyed by table name: `products`, `workspaces`, `resources`, `initiatives`,
   *  `initiative_workspace_links`, `requirements`, `acceptance_criteria`, `events`,
   *  `idempotency_results`. */
  initiativeRecordSnapshot(): Record<string, unknown[]>;
  /** Stops the running server and starts a fresh one over the SAME `stateDir` — `executions.db`
   *  and `initiatives.db` persist across the call, and boot reconciliation (including outbox
   *  replay) runs against the reopened stores (SPEC-003 Task I-6). Returns a NEW handle sharing
   *  this one's token/state; the original handle's `close()` remains safe to call afterward
   *  (every underlying stop/cleanup call is idempotent) but now targets an already-stopped
   *  server. */
  restart(): Promise<HarnessHandle>;
  close(): Promise<void>;
}

export interface BootOptions {
  provider: Provider;
  cwd: string;
  /** Opt-in to JSONL diagnostic logging. Default false — tests should not
   *  pollute the user's global mma-YYYY-MM-DD.jsonl. The observability
   *  fixture sets this to true so it can read emitted events back from disk. */
  diagnosticsLog?: boolean;
  /** Test-only seam (SPEC-003 Task I-6): makes the in-process `InitiativeLinker`'s FIRST
   *  consumption attempt after a terminal execution fail deterministically — the outbox row it
   *  was replaying is left unconsumed, without corrupting the already-written terminal
   *  execution result (that write landed independently, before replay ever runs). Implemented
   *  by intercepting the running server's own `initiativeRuntime.execute()` — the exact call
   *  `InitiativeLinker.replayRow()` makes as its first mutating step (`evidence_add` for the
   *  `execution://<id>` locator) — and throwing once. A subsequent replay attempt (a later
   *  terminal write, or boot reconciliation after `restart()`) is unaffected. Default false. */
  failLinkerOnceAfterTerminal?: boolean;
}

function installLoopbackOnlyFetch(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const parsed = new URL(requestUrl);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error(`contract test attempted network call: ${requestUrl}`);
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

export async function boot(opts: BootOptions): Promise<HarnessHandle> {
  installLoopbackOnlyFetch();
  freezeClock();
  process.env.MMA_TEST_INTROSPECTION = '1';
  process.env.MMA_TEST_PROVIDER_OVERRIDE = '1';
  __setCoreTestProviderOverride(opts.provider);
  // Give standard and complex different canonical identities so R3 separation
  // (forbiddenIdentities) doesn't block fallback in single-provider test mode.
  // Each tier gets a config-wrapped copy differing only in baseUrl path suffix
  // so canonicalIdentity resolves to distinct normalizedEndpoints while model
  // names and all run behavior stay identical.
  const origBaseUrl = (opts.provider.config as Record<string, unknown>).baseUrl ?? 'http://mock.local';
  const standardProvider = { ...opts.provider, config: { ...opts.provider.config, baseUrl: `${origBaseUrl}/standard` } };
  const complexProvider = { ...opts.provider, config: { ...opts.provider.config, baseUrl: `${origBaseUrl}/complex` } };
  const mainProvider = { ...opts.provider, config: { ...opts.provider.config, baseUrl: `${origBaseUrl}/main` } };
  __setCoreTestProviderOverrideMap(new Map([['standard', standardProvider], ['complex', complexProvider], ['main', mainProvider]]));

  const token = randomUUID();
  const tokenPath = join(tmpdir(), `mma-test-token-${randomUUID()}`);
  writeFileSync(tokenPath, `${token}\n`, 'utf8');

  const config: MultiModelConfig = {
    agents: {
      standard: {
        type: 'codex',
        baseUrl: 'http://mock.local',
        apiKey: 'stub',
        model: 'mock',
      },
      complex: {
        type: 'codex',
        baseUrl: 'http://mock.local',
        apiKey: 'stub',
        model: 'mock',
      },
      // A REAL model id, unlike the workers' 'mock'. `agents.main` is the cost
      // baseline every run is priced against, so an unprofiled id would make
      // mainEquivalentCostUsd null and there would be nothing to assert.
      main: {
        type: 'codex',
        baseUrl: 'http://mock.local',
        apiKey: 'stub',
        model: 'gpt-5.6-terra',
      },
    },
    diagnostics: {
      log: opts.diagnosticsLog ?? false,
    },
    server: {
      bind: '127.0.0.1',
      port: 0,
      auth: { tokenFile: tokenPath },
      limits: {
        maxBodyBytes: 10_485_760,
        batchTtlMs: 3_600_000,
        projectCap: 200,
        maxContextBlockBytes: 524_288,
        maxContextBlocksPerProject: 32,
        shutdownDrainMs: 30_000,
      },
      autoUpdateSkills: false,
      // Isolated per-process state dir — server tests must never touch the
      // developer's real ~/.mma/state (executions.db). Fixed for the life of this boot() call
      // (including across restart()) so executions.db/initiatives.db persist across a restart.
      stateDir: mkdtempSync(join(tmpdir(), 'mma-test-state-')),
    },
  };

  let server = await startServer(config, { driftReport: () => [] });

  if (opts.failLinkerOnceAfterTerminal) {
    installFailOnceLinkerHook(server);
  }

  function unconsumedOutbox(): HarnessOutboxRow[] {
    const db = new DatabaseSync(join(config.server.stateDir, 'executions.db'));
    try {
      const rows = db.prepare(
        'SELECT execution_id, consumed_at FROM outbox WHERE consumed_at IS NULL ORDER BY created_at ASC',
      ).all() as Array<{ execution_id: string; consumed_at: number | null }>;
      return rows.map((row) => ({ executionId: row.execution_id, consumedAt: row.consumed_at }));
    } finally {
      db.close();
    }
  }

  function executionRowCount(): number {
    const db = new DatabaseSync(join(config.server.stateDir, 'executions.db'));
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number };
      return Number(row.n);
    } finally {
      db.close();
    }
  }

  const INITIATIVE_RECORD_SNAPSHOT_TABLES = [
    'products',
    'workspaces',
    'resources',
    'initiatives',
    'initiative_workspace_links',
    'requirements',
    'acceptance_criteria',
    'events',
    'idempotency_results',
  ] as const;

  function initiativeRecordSnapshot(): Record<string, unknown[]> {
    const db = new DatabaseSync(join(config.server.stateDir, 'initiatives.db'));
    try {
      const snapshot: Record<string, unknown[]> = {};
      for (const table of INITIATIVE_RECORD_SNAPSHOT_TABLES) {
        snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      }
      return snapshot;
    } finally {
      db.close();
    }
  }

  function buildHandle(): HarnessHandle {
    return {
      baseUrl: `http://127.0.0.1:${server.port}`,
      token,
      executionRegistry: server.executionRegistry,
      unconsumedOutbox,
      executionRowCount,
      initiativeRecordSnapshot,
      async restart(): Promise<HarnessHandle> {
        await server.stop();
        // Reopens over the SAME `config` (same stateDir, same token file) — a fresh
        // `initiativeLinker`/`initiativeRuntime`/`executionStore` triple, never the
        // failLinkerOnceAfterTerminal hook installed above (that hook lives on THIS
        // process's `initiativeRuntime` instance, discarded by `server.stop()`).
        server = await startServer(config, { driftReport: () => [] });
        return buildHandle();
      },
      async close(): Promise<void> {
        await server.stop();
        __setCoreTestProviderOverride(null);
        __setCoreTestProviderOverrideMap(null);
        await unlink(tokenPath).catch(() => undefined);
      },
    };
  }

  return buildHandle();
}

/**
 * Test-only monkeypatch (SPEC-003 Task I-6, `BootOptions.failLinkerOnceAfterTerminal`): makes
 * the running server's `InitiativeLinker` fail its first outbox-row replay attempt. Overrides
 * the ONE `InitiativeRecordRuntime` instance `RunningServer.initiativeRuntime` exposes and
 * `InitiativeLinker` (constructed in `http/server.ts` over that same instance) both hold — so
 * intercepting `execute()` here is intercepting exactly what `InitiativeLinker.replayRow()`
 * calls, without any production code needing a test seam. Scoped to the FIRST `evidence_add`
 * call whose `locator` is an `execution://` URI — `replayRow()`'s own first mutating step —
 * so a test's ordinary `/initiatives` traffic (product/initiative/task creation and claiming)
 * is never affected.
 */
function installFailOnceLinkerHook(server: RunningServer): void {
  const runtime = server.initiativeRuntime as unknown as { execute: (request: unknown) => unknown };
  const originalExecute = runtime.execute.bind(server.initiativeRuntime);
  let failed = false;
  runtime.execute = (request: unknown): unknown => {
    const op = (request as { operation?: unknown } | null)?.operation;
    const locator = (request as { input?: { locator?: unknown } } | null)?.input?.locator;
    if (!failed && op === 'evidence_add' && typeof locator === 'string' && locator.startsWith('execution://')) {
      failed = true;
      throw new Error('mma-test: forced InitiativeLinker replay failure (failLinkerOnceAfterTerminal)');
    }
    return originalExecute(request);
  };
}
