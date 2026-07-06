// Full-pipeline smoke — pinned constants. All values confirmed against the codebase
// (events_raw migrations, wire-schema, telemetry paths) on 2026-06-12.
//
// Redesigned as a comprehensive product release gate: 22 scenarios, each testing
// a DISTINCT product capability. No duplicates. Covers task types, audit subtypes,
// tier/review policy overrides, session reuse, error cases, sandbox confinement,
// and telemetry.
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME_MM = join(homedir(), '.mma');

export const PORT = 7337;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const TOKEN_FILE = join(HOME_MM, 'auth-token');
export const QUEUE_FILE = process.env.SMOKE_QUEUE_FILE || join(HOME_MM, 'telemetry-queue.ndjson');
export const INSTALL_ID_FILE = join(HOME_MM, 'install-id');
export const DIAG_DIR = process.env.MMA_LOG_DIR || join(HOME_MM, 'logs'); // mma-YYYY-MM-DD.jsonl

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
// The 22-scenario release gate.
//
// Each scenario tests a DISTINCT product capability:
//
//   A. Task Types (11 types — one scenario each):
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
//      #19 orchestrate       — orchestration brain (read, main tier, no reviewer)
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
//      #18 missing field    — POST /task with type: 'investigate' but no prompt/target → 400
//
//   F. Sandbox Confinement:
//      #20 delegate cwd-escape  — worker instructed to write /tmp; hook denies, worker adapts
//      #21 delegate cd-chain    — worker instructed to cd /tmp && touch; hardened hook catches
//      #22 audit read-only      — read-only sandbox completes normally without write capability
//
// `emits` = how many wire telemetry records this scenario produces. The wire
// pipeline emits ONE record per sealed task envelope:
//   - context-blocks → 0 (synchronous state op, no worker run)
//   - research       → 0 (aggregation fan-out; no per-task wire record)
//   - error cases    → 0 (rejected at validation, no worker dispatched)
//   - all others     → 1
// ─────────────────────────────────────────────────────────────────────────────
export const SCENARIOS = [
  // A. Task Types (11 base types)
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
  { id: 19, type: 'orchestrate', tier: 'main', kind: 'write', reviewPolicy: 'none', emits: 1 },

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

  // F. Sandbox Confinement (cwd-only and read-only enforcement)
  //    #20: delegate where the task prompt attempts to write outside cwd.
  //         The PreToolUse confinement hook should deny the escape; the worker
  //         adapts and writes in-cwd instead. Verifies the task still completes
  //         successfully despite the hook firing.
  //    #21: delegate where the task prompt attempts a cd-chain escape
  //         (cd /tmp && touch file). The hardened hook tracks effective cwd
  //         and denies the out-of-workspace write.
  //    #22: audit (read-only) that verifies the read-only sandbox allows
  //         the task to complete normally without write capability.
  { id: 20, type: 'delegate', tier: 'standard', kind: 'write', tasks: 1, reviewPolicy: 'none', sandbox: 'cwd-only', emits: 1 },
  { id: 21, type: 'delegate', tier: 'standard', kind: 'write', tasks: 1, reviewPolicy: 'none', sandbox: 'cwd-only', emits: 1 },
  { id: 22, type: 'audit', subtype: 'default', tier: 'complex', kind: 'read', sandbox: 'read-only', emits: 1 },

  // G. Uncommitted plan file (worktree copy)
  //    #23: execute_plan with a plan file that exists on disk but is NOT committed
  //         to git. The pipeline must copy it into the worktree before the worker
  //         can read it. Verifies the copyToWorktree mechanism.
  { id: 23, type: 'execute_plan', tier: 'standard', kind: 'write', uncommittedPlan: true, emits: 1 },

  // H. New task types (spec + plan)
  //    #24: spec — write a formal spec from structured design decisions (inline)
  //    #25: plan — write a TDD plan from a spec file
  { id: 24, type: 'spec', tier: 'complex', kind: 'write', emits: 1 },
  { id: 25, type: 'plan', tier: 'complex', kind: 'write', emits: 1 },

  // I. Context block delta mode
  //    #26: audit round 2 with contextBlockId from round 1 (#4).
  //         Verifies the delta flow: round 1 produces contextBlockId →
  //         round 2 passes it → worker sees ## Prior Context section.
  { id: 26, type: 'audit', subtype: 'default', tier: 'complex', kind: 'read', delta: true, emits: 1 },

  // J. Error: too many context blocks (>2 rejected)
  { id: 27, type: 'error_too_many_blocks', kind: 'error', expectStatus: 400, emits: 0 },

  // K. Non-git cwd: delegate works without a git repo (no worktree)
  { id: 28, type: 'delegate', tier: 'standard', kind: 'write', nonGitCwd: true, reviewPolicy: 'none', emits: 1 },
];
