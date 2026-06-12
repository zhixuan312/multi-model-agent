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

export const SCHEMA_VERSION = 6; // packages/core/src/events/wire-schema.ts

// events_raw flat columns that always exist (001_init.sql). Per-tier model/cost
// detail lives in the `event` JSONB column, not flat columns — parse that.
export const EVENTS_RAW_COLUMNS = ['event_id', 'install_id', 'received_at', 'route', 'terminal_status', 'schema_version'];

export const APPROVED_DB_HOSTS = ['localhost', '127.0.0.1', '::1', ''];

export const POLL = {
  taskEveryMs: 1500, taskMaxMs: 10 * 60 * 1000,
  backendEveryMs: 2000, backendMaxMs: 60 * 1000,
};

// The 15-dispatch cycle. `id` stable; flags drive verify.mjs.
//
// `emits` = how many wire telemetry records (events_raw rows) this scenario is
// expected to produce. The wire pipeline emits ONE record per sealed task
// envelope (telemetry-uploader dedups by taskId), so:
//   - delegate            → one per task  (`tasks`, default 1)
//   - execute-plan        → one per task descriptor (each descriptor seals its
//                              own task envelope → its own wire record). Scenario
//                              8 dispatches 2 descriptors, so emits 2.
//   - investigate/audit/review/debug → 1 (single read run)
//   - journal_record      → 1 (write route; one worker writes the journal nodes)
//   - journal_recall      → 1 (read route, investigate-shaped; multi-criteria
//                              fan-out is sub-runs within one sealed envelope)
//   - retry               → 1 (re-runs the one seeded failed task)
//   - context-blocks      → 0 (synchronous state op, no worker run)
//   - research            → 0 (aggregation fan-out; emits no per-task wire
//                              record on the standard path — revisit if the
//                              research telemetry model changes)
// Run-level expected = sum(emits). This replaces the old sum(results.length),
// which over-counted execute-plan's internal outcomes and research.
export const SCENARIOS = [
  { id: 1,  type: 'context-blocks', kind: 'assist', emits: 0 },
  { id: 2,  type: 'investigate', tier: 'complex', kind: 'read', emits: 1 },
  { id: 3,  type: 'research', tier: 'complex', kind: 'read', network: true, emits: 0 },
  { id: 4,  type: 'audit', tier: 'complex', kind: 'read', emits: 1 },
  // Goal mode (5.1.0): each write call is ONE sequential goal-set → ONE result,
  // regardless of how many tasks it bundles. No parallel fan-out.
  { id: 5,  type: 'delegate', tier: 'standard', kind: 'write', tasks: 2, emits: 1 },
  { id: 6,  type: 'delegate', tier: 'complex', kind: 'write', tasks: 1, emits: 1 },
  { id: 7,  type: 'delegate', tier: 'standard', kind: 'write', tasks: 2, emits: 1 },
  { id: 8,  type: 'execute_plan', tier: 'standard', kind: 'write', emits: 1 },
  { id: 'seed', type: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none', seed: true, emits: 1 },
  { id: 9,  type: 'review', tier: 'complex', kind: 'read', emits: 1 },
  { id: 10, type: 'debug', tier: 'complex', kind: 'read', emits: 1 },
  { id: 11, type: 'delegate', tier: 'standard', kind: 'write', emits: 1 },
  { id: 12, type: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none', emits: 1 },
  { id: 13, type: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none', emits: 1 },
  { id: 14, type: 'retry_tasks', kind: 'assist', emits: 1 },
  // Journal (4.8.0). Record (write) must run before recall (read) so the recall
  // worker has populated .mmagent/journal/ to read. Both complex-tier.
  { id: 15, type: 'journal_record', tier: 'complex', kind: 'write', emits: 1 },
  { id: 16, type: 'journal_recall', tier: 'complex', kind: 'read', emits: 1 },
  // Delegate skill passthrough (4.9.0). 17 = happy path: a delegate task that
  // names an installed skill resolves it from the main-agent store, stages it,
  // and the worker launches + completes normally (proves resolve→stage→native
  // delivery doesn't break the session, on whichever provider `standard` maps
  // to). 18 = hard-fail path: an unknown skill name must fail THAT task with
  // `skill_not_found` (proves the skills field reaches live resolution and the
  // failure is clean per-task). 18 bypasses the lifecycle (short-circuit) so it
  // seals a terminal-failed envelope whose telemetry record uploads cleanly
  // (errorCode bucketed as 'other'; the precise skill code rides structuredError)
  // → emits 1.
  { id: 17, type: 'delegate', tier: 'standard', kind: 'write', reviewPolicy: 'none', skills: ['mma-smoke-skill'], emits: 1 },
  { id: 18, type: 'delegate', tier: 'standard', kind: 'write', skills: ['__mma_nonexistent_skill__'], expectSkillError: 'skill_not_found', emits: 1 },
  // Rich goal-set (5.1.0): 4 tasks across 2 plan-phases; full implement→review-fix
  // with PHASE checkpoints + intra-goal dependencies. One goal-set → one result.
  { id: 19, type: 'execute_plan', tier: 'standard', kind: 'write', tasks: 4, emits: 1 },
];

// 4.7.20 universal terminal context block: the per-route `context-block` check in
// verify.mjs asserts read routes surface a non-null `contextBlockId` and write
// routes surface exactly `null`. Resolution of a passed-in contextBlockId is
// already exercised live by scenario 4 (audit with `contextBlockIds`), and the
// byte-for-byte terminal-block expansion is covered by the unit test
// tests/lifecycle/terminal-block-delta.test.ts — so no separate (slow, complex-
// tier) delta scenario is run here.
