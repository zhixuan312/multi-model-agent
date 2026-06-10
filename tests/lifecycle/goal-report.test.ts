import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGoalReport, parseGoalSummary, taskNumberFromSubject } from '../../packages/core/src/lifecycle/goal-report.js';
import { assembleGoal } from '../../packages/core/src/lifecycle/goal-builder.js';
import type { Goal } from '../../packages/core/src/types/goal.js';

let dir: string;
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', encoding: 'utf8' });

function commitFile(name: string, subject: string): void {
  writeFileSync(join(dir, name), `${name}\n`);
  git('add', '-A');
  git('commit', '-qm', subject);
}

function goalFor(headings: string[]): Goal {
  return assembleGoal({
    source: 'execute-plan', cwd: dir,
    tasks: headings.map((h) => ({ heading: h, body: h, phase: 1 })),
    phases: [{ tier: 'standard', mode: 'implement' }, { tier: 'complex', mode: 'review-fix' }],
    reviewPolicy: 'review-fix', tools: 'full', sandboxPolicy: 'cwd-only',
  });
}

const SUMMARY = (tasks: Array<{ task: number; status: string }>) =>
  '```json\n' + JSON.stringify({ tasks: tasks.map((t) => ({ ...t, heading: 'h', filesChanged: [], verification: [] })), overall: 'done' }) + '\n```';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goal-report-'));
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n'); git('add', '-A'); git('commit', '-qm', 'seed');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseGoalSummary / taskNumberFromSubject', () => {
  it('parses the last fenced json block and the [task N] prefix', () => {
    expect(parseGoalSummary(SUMMARY([{ task: 1, status: 'done' }]))?.tasks[0]!.task).toBe(1);
    expect(taskNumberFromSubject('[task 7] do the thing')).toBe(7);
    expect(taskNumberFromSubject('no prefix')).toBeNull();
  });
});

describe('buildGoalReport', () => {
  it('matches commits to tasks and reports done when all committed', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    commitFile('a.ts', '[task 1] add a');
    commitFile('b.ts', '[task 2] add b');
    const gr = await buildGoalReport({ goal: goalFor(['add a', 'add b']), baseSha: base, phase1Output: SUMMARY([{ task: 1, status: 'done' }, { task: 2, status: 'done' }]) });
    expect(gr.commitCount).toBe(2);
    expect(gr.report.workerStatus).toBe('done');
    expect(gr.report.filesChanged.sort()).toEqual(['a.ts', 'b.ts']);
    expect(gr.payload.completed).toBe(true);
  });

  it('benign phase-2 review notes do NOT downgrade a clean run to done_with_concerns', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    commitFile('a.ts', '[task 1] add a');
    const p1 = SUMMARY([{ task: 1, status: 'done' }]);
    // Phase 2 reviewed and emitted a non-empty informational finding, all done.
    const p2 = '```json\n' + JSON.stringify({
      tasks: [{ task: 1, heading: 'h', filesChanged: [], verification: [], status: 'done' }],
      overall: 'reviewed', findings: [{ category: 'review_note', claim: 'task 1 looks correct, no change' }],
    }) + '\n```';
    const gr = await buildGoalReport({ goal: goalFor(['add a']), baseSha: base, phase1Output: p1, phase2Output: p2 });
    expect(gr.report.workerStatus).toBe('done');
    expect(gr.payload.completed).toBe(true);
  });

  it('phase-2 status override: a task phase-1 failed but phase-2 committed is done', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    commitFile('a.ts', '[task 1] add a'); // phase 2 ended up committing it
    const p1 = SUMMARY([{ task: 1, status: 'failed' }]);     // phase 1 gave up
    const p2 = SUMMARY([{ task: 1, status: 'done' }]);       // phase 2 finished it
    const gr = await buildGoalReport({ goal: goalFor(['add a']), baseSha: base, phase1Output: p1, phase2Output: p2 });
    expect(gr.report.workerStatus).toBe('done');
  });

  it('reports each NOT-done task with its reason (a task with no commit)', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    commitFile('a.ts', '[task 1] add a'); // task 2 never committed
    const gr = await buildGoalReport({ goal: goalFor(['add a', 'add b']), baseSha: base, phase1Output: SUMMARY([{ task: 1, status: 'done' }]) });
    expect(gr.report.workerStatus).toBe('done_with_concerns');
    const nd = gr.report.findings.find((f) => f.category === 'task_not_done');
    expect(nd).toBeDefined();
    expect(nd!.claim).toMatch(/task 2/);
    expect(nd!.claim).toMatch(/no commit/);
    // The summary tells the caller the clean per-task roll-up; no review churn.
    expect(gr.report.summary).toMatch(/1\/2 task\(s\) done/);
    expect(gr.report.summary).toMatch(/Not done: task 2/);
    expect(gr.report.reviewConcerns).toEqual([]);
    expect(gr.report.reworkApplied).toBe(false);
  });

  it('a committed-but-reported-failed task is NOT done, with the note as the reason', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    commitFile('a.ts', '[task 1] add a');
    const p1 = '```json\n' + JSON.stringify({ tasks: [{ task: 1, heading: 'add a', filesChanged: [], verification: [], status: 'failed', note: 'compile error remains' }], overall: 'x' }) + '\n```';
    const gr = await buildGoalReport({ goal: goalFor(['add a']), baseSha: base, phase1Output: p1 });
    expect(gr.report.workerStatus).toBe('done_with_concerns');
    const nd = gr.report.findings.find((f) => f.category === 'task_not_done');
    expect(nd!.claim).toMatch(/reported failed: compile error remains/);
  });

  it('zero commits → failed; the summary says nothing was committed', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    const gr0 = await buildGoalReport({ goal: goalFor(['add a']), baseSha: base, phase1Output: SUMMARY([{ task: 1, status: 'failed' }]) });
    expect(gr0.commitCount).toBe(0);
    expect(gr0.report.workerStatus).toBe('failed');
    expect(gr0.report.summary).toMatch(/nothing was committed/);
  });
});
