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
//
// `emits` = how many wire telemetry records (events_raw rows) this scenario is
// expected to produce. The wire pipeline emits ONE record per sealed task
// envelope (telemetry-uploader dedups by taskId), so:
//   - delegate            → one per task  (`tasks`, default 1)
//   - execute-plan        → 1 (a single worker session runs the whole plan;
//                              its multiple taskOutcomes are NOT separate runs)
//   - investigate/audit/review/debug → 1 (single read run)
//   - retry               → 1 (re-runs the one seeded failed task)
//   - context-blocks      → 0 (synchronous state op, no worker run)
//   - research            → 0 (aggregation fan-out; emits no per-task wire
//                              record on the standard path — revisit if the
//                              research telemetry model changes)
// Run-level expected = sum(emits). This replaces the old sum(results.length),
// which over-counted execute-plan's internal outcomes and research.
export const SCENARIOS = [
  { id: 1,  route: 'context-blocks', kind: 'assist', emits: 0 },
  { id: 2,  route: 'investigate', tier: 'complex', kind: 'read', emits: 1 },
  { id: 3,  route: 'research', tier: 'complex', kind: 'read', network: true, emits: 0 },
  { id: 4,  route: 'audit', tier: 'complex', kind: 'read', emits: 1 },
  { id: 5,  route: 'delegate', tier: 'standard', kind: 'write', dispatchMode: 'parallel', tasks: 2, emits: 2 },
  { id: 6,  route: 'delegate', tier: 'complex', kind: 'write', dispatchMode: 'parallel', tasks: 1, emits: 1 },
  { id: 7,  route: 'delegate', tier: 'standard', kind: 'write', dispatchMode: 'serial', tasks: 2, emits: 2 },
  { id: 8,  route: 'execute-plan', tier: 'standard', kind: 'write', dispatchMode: 'serial', emits: 1 },
  { id: 'seed', route: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none', seed: true, emits: 1 },
  { id: 9,  route: 'review', tier: 'complex', kind: 'read', emits: 1 },
  { id: 10, route: 'debug', tier: 'complex', kind: 'read', emits: 1 },
  { id: 11, route: 'delegate', tier: 'standard', kind: 'write', expectRework: 'best-effort', emits: 1 },
  { id: 12, route: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none', emits: 1 },
  { id: 13, route: 'delegate', tier: 'standard', kind: 'write', expectCommitSkip: 'no_diff', emits: 1 },
  { id: 14, route: 'retry', kind: 'assist', emits: 1 },
];
