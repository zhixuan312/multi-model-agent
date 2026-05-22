// Full-pipeline smoke — pinned constants. All values confirmed against the codebase
// (events_raw migrations, wire-schema, telemetry paths) on 2026-05-22.
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME_MM = join(homedir(), '.multi-model');

export const PORT = 7337;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const TOKEN_FILE = join(HOME_MM, 'auth-token');
export const QUEUE_FILE = process.env.SMOKE_QUEUE_FILE || join(HOME_MM, 'telemetry-queue.ndjson');
export const INSTALL_ID_FILE = join(HOME_MM, 'install-id');
export const DIAG_DIR = process.env.MMAGENT_LOG_DIR || join(HOME_MM, 'logs'); // mmagent-YYYY-MM-DD.jsonl

export const SCHEMA_VERSION = 5; // packages/core/src/events/wire-schema.ts

// events_raw flat columns that always exist (001_init.sql). Per-tier model/cost
// detail lives in the `event` JSONB column, not flat columns — parse that.
export const EVENTS_RAW_COLUMNS = ['event_id', 'install_id', 'received_at', 'route', 'terminal_status', 'schema_version'];

export const APPROVED_DB_HOSTS = ['localhost', '127.0.0.1', '::1', ''];

export const POLL = {
  batchEveryMs: 1500, batchMaxMs: 10 * 60 * 1000,
  backendEveryMs: 2000, backendMaxMs: 60 * 1000,
};

// The 15-dispatch cycle. `id` stable; flags drive verify.mjs.
export const SCENARIOS = [
  { id: 1,  route: 'context-blocks', kind: 'assist' },
  { id: 2,  route: 'investigate', tier: 'complex', kind: 'read' },
  { id: 3,  route: 'research', tier: 'complex', kind: 'read', network: true },
  { id: 4,  route: 'audit', tier: 'complex', kind: 'read' },
  { id: 5,  route: 'delegate', tier: 'standard', kind: 'write', dispatchMode: 'parallel', tasks: 2 },
  { id: 6,  route: 'delegate', tier: 'complex', kind: 'write', dispatchMode: 'parallel', tasks: 1 },
  { id: 7,  route: 'delegate', tier: 'standard', kind: 'write', dispatchMode: 'serial', tasks: 2 },
  { id: 8,  route: 'execute-plan', tier: 'standard', kind: 'write', dispatchMode: 'serial' },
  { id: 'seed', route: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none', seed: true },
  { id: 9,  route: 'review', tier: 'complex', kind: 'read' },
  { id: 10, route: 'debug', tier: 'complex', kind: 'read' },
  { id: 11, route: 'delegate', tier: 'standard', kind: 'write', expectRework: 'best-effort' },
  { id: 12, route: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none' },
  { id: 13, route: 'delegate', tier: 'standard', kind: 'write', expectCommitSkip: 'no_diff' },
  { id: 14, route: 'retry', kind: 'assist' },
];
