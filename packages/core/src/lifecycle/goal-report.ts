// Deterministic report builder for write-route goal-sets. Replaces the
// per-task commit-gate + LLM-judge annotate path: the report is rebuilt from
// `git log baseSha..HEAD` (commits matched to tasks via the `[task N]`
// convention) plus the two phases' structured-summary JSON blocks.
import type { Goal } from '../types/goal.js';
import { gitLogCommits, currentHead, isAncestor, type GitLogCommit } from './git-exec.js';
import type { StructuredReport } from './handlers/annotate-stage.js';
import type { AnnotatePayload, Finding } from './stage-io.js';

export interface ParsedTaskSummary {
  task: number;
  heading?: string;
  filesChanged?: string[];
  status?: 'done' | 'failed' | 'skipped';
  note?: string;
}

export interface ParsedGoalSummary {
  tasks: ParsedTaskSummary[];
  overall?: string;
  findings?: Array<{ severity?: string; category?: string; claim?: string; note?: string }>;
}

/** Extract the final fenced ```json block and parse the structured summary. */
export function parseGoalSummary(output: string): ParsedGoalSummary | null {
  if (!output) return null;
  // Prefer the LAST fenced json block (the agent ends with it).
  const matches = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)];
  const candidates = matches.map((m) => m[1]).filter((s): s is string => !!s);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
        return parsed as ParsedGoalSummary;
      }
    } catch { /* try the next-earlier block */ }
  }
  return null;
}

/** Parse the `[task N]` prefix from a commit subject. */
export function taskNumberFromSubject(subject: string): number | null {
  const m = subject.match(/^\[task (\d+)\]/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

export interface GoalReportInput {
  goal: Goal;
  baseSha: string;
  phase1Output: string;
  phase2Output?: string;
}

export interface GoalReportResult {
  report: StructuredReport;
  payload: AnnotatePayload;
  /** Whether at least one commit landed (drives failed vs done). */
  commitCount: number;
}

/**
 * Build the deterministic goal report from git state + phase summaries.
 * Pure-ish: only reads git; never writes.
 */
export async function buildGoalReport(input: GoalReportInput): Promise<GoalReportResult> {
  const { goal, baseSha } = input;
  const cwd = goal.cwd;
  const head = (await currentHead(cwd)) ?? baseSha;
  const commits: GitLogCommit[] = await gitLogCommits(cwd, baseSha);
  const taskCount = goal.tasks.length;

  const findings: Finding[] = [];
  const pushFinding = (severity: Finding['severity'], category: string, claim: string, extra?: Partial<Finding>) => {
    findings.push({ severity, category, claim, source: 'implementer', ...extra });
  };

  // Match commits → tasks via [task N] prefix.
  const matchedTasks = new Set<number>();
  const unmatched: GitLogCommit[] = [];
  const filesChangedSet = new Set<string>();
  for (const c of commits) {
    for (const f of c.filesChanged) filesChangedSet.add(f);
    const n = taskNumberFromSubject(c.subject);
    if (n === null) unmatched.push(c);
    else matchedTasks.add(n);
  }
  if (unmatched.length > 0) {
    pushFinding('low', 'unmatched_commit',
      `${unmatched.length} commit(s) did not use the [task N] convention`,
      { evidence: unmatched.map((c) => c.subject).slice(0, 5).join('; ') });
  }

  // History-rewrite guard: baseSha must still be an ancestor of HEAD.
  if (!(await isAncestor(cwd, baseSha, head))) {
    pushFinding('high', 'history_rewritten',
      `baseSha ${baseSha.slice(0, 8)} is no longer an ancestor of HEAD — history was rewritten`);
  }

  // Per-task statuses: phase-1 baseline, OVERRIDDEN by phase-2 (the final state —
  // a task phase 1 failed but phase 2 fixed is `done`).
  const p1 = parseGoalSummary(input.phase1Output);
  const p2 = input.phase2Output ? parseGoalSummary(input.phase2Output) : null;
  if (!p1) {
    pushFinding('medium', 'summary_unparseable',
      'phase-1 structured-summary JSON block was missing or malformed');
  }
  const statusByTask = new Map<number, ParsedTaskSummary['status']>();
  for (const t of p1?.tasks ?? []) if (t.status) statusByTask.set(t.task, t.status);
  for (const t of p2?.tasks ?? []) if (t.status) statusByTask.set(t.task, t.status); // phase-2 wins

  // Phase-2 review notes are INFORMATIONAL (what the reviewer looked at / fixed) —
  // they do NOT downgrade the run on their own. Drop empty ones; only genuine
  // unresolved work surfaces as a structural concern via per-task status below.
  for (const f of p2?.findings ?? []) {
    const text = (f.claim ?? f.note ?? '').trim();
    if (text.length > 0) pushFinding('low', f.category ?? 'review_note', text);
  }

  const failedOrSkipped: number[] = [];
  const missing: number[] = [];
  for (const t of goal.tasks) {
    const s = statusByTask.get(t.n);
    if (s === 'failed' || s === 'skipped') failedOrSkipped.push(t.n);
    if (!matchedTasks.has(t.n)) missing.push(t.n);
  }
  if (commits.length < taskCount || missing.length > 0 || failedOrSkipped.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`no commit for task(s): ${missing.join(', ')}`);
    if (failedOrSkipped.length > 0) parts.push(`failed/skipped task(s): ${failedOrSkipped.join(', ')}`);
    if (commits.length < taskCount && missing.length === 0) parts.push(`${commits.length} commits < ${taskCount} tasks`);
    pushFinding('medium', 'incomplete_plan',
      `plan not fully completed: ${parts.join('; ')}`);
  }

  const filesChanged = [...filesChangedSet];
  const lastCommit = commits[commits.length - 1];
  const overall = p2?.overall ?? p1?.overall ?? `goal-set: ${commits.length} commit(s) across ${taskCount} task(s)`;

  // done_with_concerns is driven by STRUCTURAL problems (missing/failed tasks,
  // rewritten history, unparseable summary, off-convention commits) — NOT by the
  // presence of benign phase-2 review notes. A clean, fully-committed run where
  // the reviewer found nothing wrong is `done`.
  const STRUCTURAL = new Set(['unmatched_commit', 'history_rewritten', 'summary_unparseable', 'incomplete_plan']);
  const hasConcerns = findings.some((f) => STRUCTURAL.has(f.category));
  const workerStatus: StructuredReport['workerStatus'] =
    commits.length === 0 ? 'failed' : hasConcerns ? 'done_with_concerns' : 'done';

  const report: StructuredReport = {
    summary: overall,
    workerStatus,
    unresolved: failedOrSkipped.map((n) => `task ${n} not completed`),
    filesChanged,
    reviewVerdict: input.phase2Output ? (hasConcerns ? 'changes_required' : 'approved') : null,
    reviewConcerns: (p2?.findings ?? []).map((f) => f.claim ?? f.note ?? '').filter(Boolean),
    reworkApplied: Boolean(input.phase2Output),
    commitSha: commits.length > 0 ? (head) : null,
    commitMessage: lastCommit ? lastCommit.subject : null,
    commitSkipReason: commits.length === 0 ? 'no_commits' : null,
    findings: findings.map((f) => ({ severity: f.severity, category: f.category, claim: f.claim, ...(f.evidence && { evidence: f.evidence }), ...(f.suggestion && { suggestion: f.suggestion }) })),
    criteriaErrors: [],
    findingsOutcome: hasConcerns ? 'found' : 'clean',
  };

  const payload: AnnotatePayload = {
    completed: commits.length > 0 && missing.length === 0 && failedOrSkipped.length === 0,
    message: overall,
    findings,
    summary: overall,
    filesChanged,
    commitSha: commits.length > 0 ? head : null,
  };

  return { report, payload, commitCount: commits.length };
}
