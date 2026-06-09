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

  it('flags incomplete_plan when fewer commits than tasks (AC-21)', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    commitFile('a.ts', '[task 1] add a'); // task 2 never committed
    const gr = await buildGoalReport({ goal: goalFor(['add a', 'add b']), baseSha: base, phase1Output: SUMMARY([{ task: 1, status: 'done' }]) });
    expect(gr.report.workerStatus).toBe('done_with_concerns');
    expect(gr.report.findings.some((f) => f.category === 'incomplete_plan')).toBe(true);
  });

  it('reports failed (zero commits) and flags unmatched commits', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    const gr0 = await buildGoalReport({ goal: goalFor(['add a']), baseSha: base, phase1Output: SUMMARY([{ task: 1, status: 'failed' }]) });
    expect(gr0.commitCount).toBe(0);
    expect(gr0.report.workerStatus).toBe('failed');

    commitFile('x.ts', 'no convention here');
    const gr1 = await buildGoalReport({ goal: goalFor(['add a']), baseSha: base, phase1Output: SUMMARY([{ task: 1, status: 'done' }]) });
    expect(gr1.report.findings.some((f) => f.category === 'unmatched_commit')).toBe(true);
  });
});
