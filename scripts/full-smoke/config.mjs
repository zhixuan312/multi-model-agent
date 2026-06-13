// Full-pipeline smoke — pinned constants. All values confirmed against the codebase
// (events_raw migrations, wire-schema, telemetry paths) on 2026-06-12.
//
// Redesigned as a comprehensive product release gate: 18 scenarios, each testing
// a DISTINCT product capability. No duplicates. Covers task types, audit subtypes,
// tier/review policy overrides, session reuse, error cases, and telemetry.
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

// ─────────────────────────────────────────────────────────────────────────────
// The 18-scenario release gate.
//
// Each scenario tests a DISTINCT product capability:
//
//   A. Task Types (10 types — one scenario each):
//      #1  context-blocks   — register a context block (synchronous 201)
//      #2  investigate      — codebase question (read, complex)
//      #3  research         — external research (read, complex, network)
//      #4  audit (default)  — document audit (read, complex)
//      #5  delegate         — implementation (write, standard, reviewed)
//      #6  execute_plan     — plan execution (write, standard)
//      #7  review           — code review (read, complex)
//      #8  debug            — debugging (read, complex)
//      #9  journal_record   — record a learning (write, complex)
//      #10 journal_recall   — recall learnings (read, complex, depends on #9)
//
//   B. Audit Subtypes (each loads a different skill file):
//      #11 audit/spec       — requirement prose executability
//      #12 audit/plan       — plan-vs-codebase coherence
//      #13 audit/skill      — SKILL.md reader-effectiveness
//
//   C. Tier & Review Policy overrides:
//      #14 delegate complex — override default standard tier → complex
//      #15 delegate none    — skip reviewer phase (reviewPolicy: 'none')
//
//   D. Session Reuse:
//      #16 investigate resume — resume prior session from scenario #2
//
//   E. Error Cases:
//      #17 invalid type     — POST /task with type: 'nonexistent' → 400
//      #18 missing field    — POST /task with type: 'investigate' but no question → 400
//
// `emits` = how many wire telemetry records this scenario produces. The wire
// pipeline emits ONE record per sealed task envelope:
//   - context-blocks → 0 (synchronous state op, no worker run)
//   - research       → 0 (aggregation fan-out; no per-task wire record)
//   - error cases    → 0 (rejected at validation, no worker dispatched)
//   - all others     → 1
// ─────────────────────────────────────────────────────────────────────────────
export const SCENARIOS = [
  // A. Task Types (10 base types)
  { id: 1,  type: 'context-blocks', kind: 'assist', emits: 0 },
  { id: 2,  type: 'investigate', tier: 'complex', kind: 'read', emits: 1 },
  { id: 3,  type: 'research', tier: 'complex', kind: 'read', network: true, emits: 0 },
  { id: 4,  type: 'audit', subtype: 'default', tier: 'complex', kind: 'read', emits: 1 },
  { id: 5,  type: 'delegate', tier: 'standard', kind: 'write', tasks: 1, emits: 1 },
  { id: 6,  type: 'execute_plan', tier: 'standard', kind: 'write', emits: 1 },
  { id: 7,  type: 'review', tier: 'complex', kind: 'read', emits: 1 },
  { id: 8,  type: 'debug', tier: 'complex', kind: 'read', emits: 1 },
  { id: 9,  type: 'journal_record', tier: 'complex', kind: 'write', emits: 1 },
  { id: 10, type: 'journal_recall', tier: 'complex', kind: 'read', emits: 1 },

  // B. Audit Subtypes (spec, plan, skill — each loads a different skill file)
  { id: 11, type: 'audit', subtype: 'spec', tier: 'complex', kind: 'read', emits: 1 },
  { id: 12, type: 'audit', subtype: 'plan', tier: 'complex', kind: 'read', emits: 1 },
  { id: 13, type: 'audit', subtype: 'skill', tier: 'complex', kind: 'read', emits: 1 },

  // C. Tier & Review Policy overrides
  { id: 14, type: 'delegate', tier: 'complex', kind: 'write', tasks: 1, emits: 1 },
  { id: 15, type: 'delegate', tier: 'standard', kind: 'write', tasks: 1, reviewPolicy: 'none', emits: 1 },

  // D. Session Reuse
  { id: 16, type: 'investigate', tier: 'complex', kind: 'read', sessionReuse: true, emits: 1 },

  // E. Error Cases
  { id: 17, type: 'error_invalid_type', kind: 'error', expectStatus: 400, emits: 0 },
  { id: 18, type: 'error_missing_field', kind: 'error', expectStatus: 400, emits: 0 },
];
