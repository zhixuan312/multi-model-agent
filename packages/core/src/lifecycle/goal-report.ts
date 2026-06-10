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
  const filesChangedSet = new Set<string>();
  for (const c of commits) {
    for (const f of c.filesChanged) filesChangedSet.add(f);
    const n = taskNumberFromSubject(c.subject);
    if (n !== null) matchedTasks.add(n);
  }
  // History-rewrite guard: baseSha must still be an ancestor of HEAD (a rewrite
  // makes per-task attribution unreliable).
  const historyRewritten = !(await isAncestor(cwd, baseSha, head));

  // Final per-task state. The CALLER only wants to know: is each task done, and
  // if not, what's the problem — NOT the in-between (which tier did what). A task
  // is DONE when it has a [task N] commit AND its final self-reported status
  // (phase-2 over phase-1 — the end state) is not failed/skipped.
  const p1 = parseGoalSummary(input.phase1Output);
  const p2 = input.phase2Output ? parseGoalSummary(input.phase2Output) : null;
  const statusByTask = new Map<number, ParsedTaskSummary['status']>();
  const noteByTask = new Map<number, string>();
  for (const t of [...(p1?.tasks ?? []), ...(p2?.tasks ?? [])]) {
    if (t.status) statusByTask.set(t.task, t.status); // later (phase-2) wins
    if (t.note && t.note.trim()) noteByTask.set(t.task, t.note.trim());
  }

  const notDone: Array<{ n: number; heading: string; reason: string }> = [];
  for (const t of goal.tasks) {
    const committed = matchedTasks.has(t.n);
    const status = statusByTask.get(t.n);
    if (!committed) {
      notDone.push({ n: t.n, heading: t.heading, reason: 'no commit recorded for this task' });
    } else if (status === 'failed' || status === 'skipped') {
      const note = noteByTask.get(t.n);
      notDone.push({ n: t.n, heading: t.heading, reason: `reported ${status}${note ? `: ${note}` : ''}` });
    }
  }

  // findings = ONLY the final-state problems the caller needs to act on. No
  // intermediate review notes, no "the reviewer fixed X" — just: not-done tasks.
  for (const nd of notDone) {
    pushFinding('high', 'task_not_done', `task ${nd.n} (${nd.heading}) NOT done — ${nd.reason}`);
  }
  if (historyRewritten) {
    pushFinding('high', 'history_rewritten',
      'git history was rewritten below the goal-set start commit — per-task attribution is unreliable');
  }

  const filesChanged = [...filesChangedSet];
  const lastCommit = commits[commits.length - 1];
  const doneCount = taskCount - notDone.length;
  const allDone = notDone.length === 0 && commits.length > 0 && !historyRewritten;

  // One clean answer for the main agent: are all tasks done, or which are not + why.
  const summary = commits.length === 0
    ? 'No tasks completed — nothing was committed.'
    : allDone
      ? `All ${taskCount} task(s) done and committed.`
      : `${doneCount}/${taskCount} task(s) done. Not done: `
        + notDone.map((nd) => `task ${nd.n} (${nd.reason})`).join('; ')
        + (historyRewritten ? '; history was rewritten' : '') + '.';

  const workerStatus: StructuredReport['workerStatus'] =
    commits.length === 0 ? 'failed' : allDone ? 'done' : 'done_with_concerns';

  const report: StructuredReport = {
    summary,
    workerStatus,
    unresolved: notDone.map((nd) => `task ${nd.n} (${nd.heading}): ${nd.reason}`),
    filesChanged,
    // The intermediate review process is deliberately NOT surfaced to the caller.
    reviewVerdict: null,
    reviewConcerns: [],
    reworkApplied: false,
    commitSha: commits.length > 0 ? head : null,
    commitMessage: lastCommit ? lastCommit.subject : null,
    commitSkipReason: commits.length === 0 ? 'no_commits' : null,
    findings: findings.map((f) => ({ severity: f.severity, category: f.category, claim: f.claim, ...(f.evidence && { evidence: f.evidence }), ...(f.suggestion && { suggestion: f.suggestion }) })),
    criteriaErrors: [],
    findingsOutcome: notDone.length > 0 || historyRewritten ? 'found' : 'clean',
  };

  const payload: AnnotatePayload = {
    completed: allDone,
    message: summary,
    findings,
    summary,
    filesChanged,
    commitSha: commits.length > 0 ? head : null,
  };

  return { report, payload, commitCount: commits.length };
}
