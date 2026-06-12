// Shared goal-mode test harness: a temp git repo + a mock provider whose
// session.send writes a file and self-commits it as `[task N] ...`, plus a
// goal-set TaskSpec builder. Lets integration tests exercise the real
// goal-mode write path (self-commit → git-log report → seal).
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleGoal, goalToTaskSpec } from '../../packages/core/src/lifecycle/goal-builder.js';
import { implementGoalPrompt } from '../../packages/core/src/lifecycle/goal-prompts.js';
import type { TaskSpec } from '../../packages/core/src/types.js';
import type { Provider, Session, SessionOpts, TurnResult } from '../../packages/core/src/types/run-result.js';
import type { TaskEnvelopeStore } from '../../packages/core/src/events/task-envelope.js';

/** Create a temp git repo with an initial commit; returns its cwd. */
export function makeGoalRepo(prefix = 'mma-goal-'): string {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@mma.local');
  git('config', 'user.name', 'mma test');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  return dir;
}

/** A provider whose session.send writes a file and self-commits `[task 1] ...`. */
export function committingProvider(cwd: string, opts?: { outcome?: 'found' | 'clean' }): Provider {
  let n = 0;
  return {
    name: 'standard',
    config: { type: 'claude', model: 'mock-standard' } as Provider['config'],
    openSession(sopts: SessionOpts): Session {
      const env = (sopts as { envelope?: TaskEnvelopeStore }).envelope;
      return {
        async send(): Promise<TurnResult> {
          env?.recordToolCall({ stage: 'implementing', tool: 'run_shell', filesRead: [], filesWritten: [] });
          n += 1;
          const file = `out${n}.txt`;
          writeFileSync(join(cwd, file), `change ${n}\n`);
          execFileSync('git', ['-C', cwd, 'add', '-A'], { stdio: 'ignore' });
          execFileSync('git', ['-C', cwd, 'commit', '-qm', '[task 1] do the thing'], { stdio: 'ignore' });
          const outcomeLine = opts?.outcome ? `\n\n## Outcome\n${opts.outcome}` : '';
          return {
            output: '```json\n{"tasks":[{"task":1,"heading":"do the thing","filesChanged":["' + file + '"],"verification":[],"status":"done","note":""}],"overall":"done"}\n```' + outcomeLine,
            usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 0, cachedNonReadTokens: 0 },
            turns: 1,
            durationMs: 10,
            filesRead: [],
            filesWritten: [join(cwd, file)],
            toolCallsByName: { run_shell: 1 },
            costUSD: 0.001,
            terminationReason: 'ok',
            workerSelfAssessment: 'done',
          } as unknown as TurnResult;
        },
        async close() { /* no-op */ },
      };
    },
  };
}

/** A single-task delegate goal-set TaskSpec rooted at `cwd` (reviewPolicy none). */
export function goalTask(cwd: string): TaskSpec {
  const goal = assembleGoal({
    source: 'delegate', cwd,
    tasks: [{ heading: 'do the thing', body: 'do the thing', phase: 1 }],
    phases: [{ tier: 'standard', mode: 'implement' }, { tier: 'complex', mode: 'review-fix' }],
    reviewPolicy: 'none', tools: 'full', sandboxPolicy: 'cwd-only',
  });
  return goalToTaskSpec(goal, implementGoalPrompt(goal), 60_000);
}
