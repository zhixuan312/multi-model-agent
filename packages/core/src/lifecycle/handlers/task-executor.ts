// v4.4.x — write-route Implementing stage handler.
//
// Sends the brief to the route's implementer tier via session.send,
// captures the pre-task HEAD SHA (for the Committing stage's
// worker-committed-out-of-band detection), and parses the worker's
// WorkerOutput JSON block onto state.lastRunResult so downstream
// stages (Review / Rework / Committing / Annotating) consume a
// uniform structured shape.

import type { LifecycleState } from '../stage-plan-types.js';
import type { ExecutionContext } from '../lifecycle-context.js';
import type { EventEmitter } from '../../events/event-emitter.js';
import { assembleRunResult } from '../../providers/assemble-run-result.js';
import { parseWorkerOutput } from '../worker-output-contract.js';
import { HUMAN_LABEL } from '../stage-labels.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const GIT_FORBIDDEN_INSTRUCTION = [
  '\n\nIMPORTANT — Persistence:',
  'Do NOT run any git subcommand that mutates history',
  '(commit, add, push, reset, rebase, merge, cherry-pick, etc.).',
  'The Committing stage handles persistence at the end.',
  '',
  'IMPORTANT — Structured output:',
  'End your response with a JSON-fenced block describing what you did:',
  '```json',
  '{',
  '  "summary": "one-line description",',
  '  "workerStatus": "done" | "done_with_concerns" | "blocked" | "failed",',
  '  "filesChanged": ["path/to/file.ts", ...],',
  '  "validationsRun": [{ "name": "npm test", "passed": true, "output": "..." }],',
  '  "unresolved": ["any items you could not finish"],',
  '  "commitMessage": "feat: optional Conventional Commits message"',
  '}',
  '```',
].join('\n');

async function capturePreTaskHead(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd) return undefined;
  try {
    const r = await execFileP('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    return r.stdout.trim();
  } catch {
    return undefined;
  }
}

export class TaskExecutor {
  constructor(private emitter: EventEmitter) {}

  handler = async (state: LifecycleState): Promise<void> => {
    const ctx = state.executionContext as ExecutionContext | undefined;
    if (!ctx) throw new Error('task-executor: state.executionContext not set');

    const systemPrompt = (state.systemPrompt as string | undefined) ?? '';
    const userMessage = (state.userMessage as string | undefined) ?? '';
    const base = systemPrompt.length > 0
      ? `${systemPrompt}\n\n${userMessage}`
      : userMessage;
    const instruction = base + GIT_FORBIDDEN_INSTRUCTION;

    // Snapshot HEAD before the worker runs — Committing reads this to
    // detect a worker-authored commit (HEAD moved between snapshots).
    const cwd = (state.cwd as string | undefined) ?? (ctx as { cwd?: string }).cwd;
    const preSha = await capturePreTaskHead(cwd);
    if (preSha !== undefined) {
      (state as { preTaskHeadSha?: string }).preTaskHeadSha = preSha;
    }

    this.emitter.emit({
      type: 'run_started',
      taskIndex: state.taskIndex,
      attempt: state.attemptIndex,
    });

    const session = ctx.getSession(ctx.assignedTier);
    const turn = await session.send(instruction, { stageLabel: HUMAN_LABEL.implementing });
    const result = assembleRunResult(turn);

    // Parse the worker's structured output and merge onto lastRunResult.
    const parsed = parseWorkerOutput(turn.output);
    const merged = {
      ...result,
      summary: parsed.summary,
      workerStatus: parsed.workerStatus,
      filesChanged: parsed.filesChanged,
      validationsRun: parsed.validationsRun,
      unresolved: parsed.unresolved,
      ...(parsed.commitMessage && { commitMessage: parsed.commitMessage }),
    };

    state.workerStatus = parsed.workerStatus;
    state.lastRunResult = merged;

    this.emitter.emit({
      type: 'run_completed',
      taskIndex: state.taskIndex,
      attempt: state.attemptIndex,
      usage: result.usage,
    });
  };
}
