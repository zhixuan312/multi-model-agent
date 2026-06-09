// Goal-mode prompt builders + plan rendering + tunable constants. The two
// prompts carry the per-task contract (commit convention, structured-summary
// schema, phase-checkpoint, prohibited git ops) because MMA no longer polices
// per-task. See docs/superpowers/specs/2026-06-09-goal-mode-write-routes-design.md.
import type { Goal, GoalTask } from '../types/goal.js';

// ── Tunables (spec: budgets / size guards) ──
export const PER_TASK_DEFAULT_MS = 600_000;           // 10 min per task baseline
export const GOAL_IDLE_STALL_MS = Math.max(300_000, 10 * 60_000); // ≥10 min
export const MAX_PLAN_TEXT_BYTES = 256 * 1024;        // hard-fail plan_too_large above this
export const MAX_GIT_LOG_BYTES = 128 * 1024;          // truncate handoff above this

/** Per-phase wall-clock for a goal-set of `taskCount` tasks. */
export function derivePhaseTimeoutMs(taskCount: number, override?: number): number {
  if (override && override > 0) return override;
  return Math.max(PER_TASK_DEFAULT_MS, taskCount * PER_TASK_DEFAULT_MS);
}

/** First non-empty line of `text`, trimmed to `max` chars (heading derivation). */
export function firstLine(text: string, max = 72): string {
  const line = (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  const stripped = line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '');
  return stripped.length > max ? stripped.slice(0, max - 1) + '…' : stripped;
}

const PROHIBITED_GIT = [
  'PROHIBITED git operations (local forward-only history only):',
  'NEVER run: push, fetch from / to a remote, reset --hard, rebase, commit --amend,',
  'branch -D, any force operation, or any history rewrite at or below the run start commit.',
  'You may ONLY use: git add, git commit. Anything else corrupts attribution.',
].join('\n');

function commitConvention(mode: 'implement' | 'review-fix'): string {
  if (mode === 'implement') {
    return [
      'COMMIT after completing EACH task, before starting the next.',
      'Commit subject MUST start with the exact prefix `[task N] ` (N = the task number).',
      'Format: `[task N] <task heading>`. Worked example:',
      '    git commit -m "[task 3] Add config schema validation"',
      'One commit per task. Do not batch multiple tasks into one commit.',
    ].join('\n');
  }
  return [
    'COMMIT each fix you make, before moving to the next task.',
    'Commit subject MUST start with the exact prefix `[task N] ` (N = the reviewed task number).',
    'Format: `[task N] fix: <what you changed>`. Worked example:',
    '    git commit -m "[task 3] fix: correct off-by-one in range check"',
    'If a task needs no fix, leave it as-is (do not create an empty commit).',
  ].join('\n');
}

const STRUCTURED_SUMMARY = [
  'FINAL MESSAGE: end your last message with a single fenced ```json block of exactly this shape:',
  '```json',
  '{"tasks":[{"task":1,"heading":"...","filesChanged":["..."],',
  '  "verification":[{"cmd":"...","result":"PASS"}],"status":"done","note":""}],',
  ' "overall":"one-line summary"}',
  '```',
  'status is "done" | "failed" | "skipped". `verification` MAY be empty when the task',
  'defines no commands. If you noticed a plan defect, set that task status "failed"/"skipped"',
  'and describe it in `note` (do NOT silently work around it).',
].join('\n');

function phaseCheckpoint(phaseCount: number): string {
  if (phaseCount <= 1) {
    return 'Before your final message: confirm every task is committed, then write the structured summary.';
  }
  return [
    `The plan has ${phaseCount} phases (marked \`PHASE k:\`). At each PHASE boundary:`,
    '1. Ensure every task in that phase is committed.',
    '2. Emit a one-line `PHASE-k summary: <what got done>`.',
    '3. Re-ground from `git log` + the plan for the next phase rather than relying on memory.',
  ].join('\n');
}

/** Render the goal's tasks into one prompt body with PHASE + [task N] markers. */
export function renderPlanText(tasks: GoalTask[], phaseCount: number): string {
  const out: string[] = [];
  let lastPhase = 0;
  for (const t of tasks) {
    if (phaseCount > 1 && t.phase !== lastPhase) {
      out.push('', `PHASE ${t.phase}:`);
      lastPhase = t.phase;
    }
    out.push('', `[task ${t.n}] ${t.heading}`, t.body);
  }
  return out.join('\n').trim();
}

const IMPLEMENT_ORIENTATION = [
  'You are the autonomous executor of a multi-task plan written by a higher-capability model.',
  'Execute EVERY task below, in order, exactly as specified — implement, do not redesign.',
  '',
  'The four ways execution diverges from intent — check yourself against each per task:',
  '1. CODE SUBSTITUTION — plan gave a code block; you wrote different code. The plan code is the contract; copy it verbatim.',
  '2. STEP SKIP — plan listed steps; you omitted some. Every step is required unless marked optional.',
  '3. PLAN REWRITE — you "improved" the plan. That is a contract violation; implement what is written.',
  '4. PROBLEM-NOT-FLAGGED — you noticed a plan defect and silently worked around it. Report it in the task note instead.',
].join('\n');

/** Phase-1 implement prompt over the whole plan. */
export function implementGoalPrompt(goal: Goal): string {
  return [
    IMPLEMENT_ORIENTATION,
    ...(goal.preamble ? ['', goal.preamble] : []),
    '',
    commitConvention('implement'),
    '',
    PROHIBITED_GIT,
    '',
    'Run any verification commands the plan lists; record each result.',
    '',
    phaseCheckpoint(goal.phaseCount),
    '',
    STRUCTURED_SUMMARY,
    '',
    '─────────────────────── PLAN ───────────────────────',
    goal.planText,
  ].join('\n');
}

/**
 * Phase-2 review-fix prompt. You are the COMPLETION GUARANTOR, not just a
 * reviewer of commits. The implementer (a cheaper tier) attempted every task but
 * may have left some incomplete, wrong, OR done-but-uncommitted. Your job is to
 * make sure EVERY task ends up correctly implemented AND committed — walking the
 * tasks one by one against both the commit log and the uncommitted working tree.
 */
export function reviewFixGoalPrompt(goal: Goal, gitLog: string, workingTree: string): string {
  return [
    'You are the COMPLETION GUARANTOR for the plan below. A prior implementer (a cheaper',
    'tier) attempted every task. It may have: committed a task correctly ([task N] …), done',
    'the work but left it UNCOMMITTED in the working tree, implemented a task WRONGLY or',
    'INCOMPLETELY, or not done it at all. Your job: make sure EVERY task is correctly',
    'implemented AND committed by the end. Do not assume the commit log is complete —',
    'inspect the working tree too.',
    ...(goal.preamble ? ['', goal.preamble] : []),
    '',
    'Work through the tasks ONE BY ONE, in order. For each task:',
    '1. Determine its real state — check the commit log AND the uncommitted working tree',
    '   (and the files themselves). Did the implementer actually do it, correctly?',
    '2. If it is correct but NOT yet committed → commit it as `[task N] <heading>`.',
    '3. If it is incomplete or wrong → finish/fix it, then commit as `[task N] fix: <what>`.',
    '4. If it is correct and already committed → verify it matches the plan; only re-commit',
    '   if you actually change something.',
    '',
    'By the end EVERY task MUST be implemented and committed, and the working tree MUST be',
    'clean (no uncommitted changes left behind).',
    '',
    commitConvention('review-fix'),
    '',
    PROHIBITED_GIT,
    '',
    phaseCheckpoint(goal.phaseCount),
    '',
    STRUCTURED_SUMMARY,
    'Additionally include a top-level "findings" array in the JSON: what was wrong/missing,',
    'what you completed or fixed, and anything that remains unresolved.',
    '',
    '──────────────── COMMITS SO FAR (git log --stat) ────────────────',
    gitLog || '(no commits yet — the implementer committed nothing)',
    '',
    '──────────────── UNCOMMITTED WORK (git status) ────────────────',
    workingTree,
    '',
    '─────────────────────── PLAN ───────────────────────',
    goal.planText,
  ].join('\n');
}
