// v4.5 — Implementing stage handler.
// Sends the brief to the route's implementer tier via session.send,
// captures the pre-task HEAD SHA, and returns a StageGate<ImplementPayload>
// containing the worker's structured output plus prose-extracted findings.

import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, ImplementPayload, RouteName } from '../stage-io.js';
import { parseWorkerOutput } from '../worker-output-contract.js';
import type { Finding } from '../stage-io.js';
import { runWorkerTurn } from '../../providers/run-worker-turn.js';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const READ_ROUTES: RouteName[] = ['audit', 'review', 'debug', 'investigate', 'explore'];

export function capturePreTaskState(state: LifecycleState): void {
  const cwd = state.cwd as string | undefined;
  if (!cwd) return;

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (headResult.status !== 0) return;
  (state as { preTaskHeadSha?: string }).preTaskHeadSha = headResult.stdout.trim();

  const lsResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
  if (lsResult.status !== 0) {
    (state as { preTaskUntrackedFiles?: Set<string> }).preTaskUntrackedFiles = new Set();
    return;
  }
  const relativeFiles = lsResult.stdout.split('\n').filter(line => line.length > 0);
  (state as { preTaskUntrackedFiles?: Set<string> }).preTaskUntrackedFiles = new Set(
    relativeFiles.map((rel) => join(cwd, rel))
  );
}

// Forward declaration — the actual parser lives in findings-parser.ts.
// We parse inline to keep the dependency lightweight and avoid importing
// the full findings-parser which may have criteria-specific logic.
function parseFindingsFromProse(text: string): Finding[] {
  if (!text || text.trim().length === 0) return [];

  const blocks: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  for (const line of lines) {
    if (/^## Finding \d+:/.test(line)) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));

  const findings: Finding[] = [];
  const SEVERITY_VALUES = new Set(['critical', 'high', 'medium', 'low']);

  for (const block of blocks) {
    const claimLine = block.match(/^\s*- Claim:\s*(.+)$/im)?.[1]?.trim() ?? '';
    if (claimLine.startsWith('[N/A]')) continue;

    const sevRaw = block.match(/^\s*- Severity:\s*(\w+)/im)?.[1]?.toLowerCase();
    const severity: Finding['severity'] =
      sevRaw && SEVERITY_VALUES.has(sevRaw)
        ? (sevRaw as Finding['severity'])
        : 'medium';
    const category = block.match(/^\s*- Category:\s*(\S+)/im)?.[1] ?? 'general';
    const evidence = block.match(/^\s*- (?:Issue|Evidence):\s*(.+)$/im)?.[1]?.trim();
    const suggestion = block.match(/^\s*- (?:Suggestion|Fix):\s*(.+)$/im)?.[1]?.trim();

    const f: Finding = { severity, category, claim: claimLine, source: 'implementer' };
    if (evidence) f.evidence = evidence;
    if (suggestion) f.suggestion = suggestion;
    findings.push(f);
  }
  return findings;
}

function defaultImplementPayload(self: 'done' | 'failed'): ImplementPayload {
  return {
    workerSelfAssessment: self,
    summary: '',
    filesChanged: [],
    findings: [],
    citations: [],
    criteriaSucceeded: [],
    criteriaErrors: [],
    sourcesUsed: [],
  };
}

function tel(
  t0: number,
  turn: { costUSD?: number; turnsUsed?: number },
  stop: string,
): StageGate<ImplementPayload>['telemetry'] {
  return {
    stageLabel: 'implement',
    durationMs: Date.now() - t0,
    costUSD: turn.costUSD ?? null,
    turnsUsed: turn.turnsUsed ?? 0,
    stopReason: stop as StageGate<ImplementPayload>['telemetry']['stopReason'],
  };
}

export async function implementHandler(
  state: LifecycleState,
): Promise<StageGate<ImplementPayload>> {
  const t0 = Date.now();

  try {
    // Snapshot HEAD + untracked files before the worker runs — Committing reads
    // this to detect a worker-authored commit (HEAD moved between snapshots).
    capturePreTaskState(state);

    const ctx = state.executionContext;
    if (!ctx) {
      return {
        outcome: 'halt',
        comment: 'implement halted: state.executionContext not set',
        payload: defaultImplementPayload('failed'),
        telemetry: tel(t0, {}, 'transport_error'),
      };
    }

    const turn = await runWorkerTurn({
      task: state.task as Parameters<typeof runWorkerTurn>[0]['task'],
      config: ctx.config,
      ctx,
      route: state.route ?? 'delegate',
    });

    if (turn.kind === 'transport_error') {
      return {
        outcome: 'halt',
        comment: `provider_transport_failure: ${turn.message}`,
        payload: defaultImplementPayload('failed'),
        telemetry: tel(t0, {}, 'transport_error'),
      };
    }
    if (turn.kind === 'sandbox_violation') {
      return {
        outcome: 'halt',
        comment: `sandbox_violation: ${turn.path}`,
        payload: defaultImplementPayload('failed'),
        telemetry: tel(t0, {}, 'transport_error'),
      };
    }

    const parsed = parseWorkerOutput(turn.text);
    const isRead = READ_ROUTES.includes(state.route as RouteName);

    // Read routes additionally extract Finding blocks from prose.
    const findings = isRead ? parseFindingsFromProse(turn.text) : [];

    const payload: ImplementPayload = {
      workerSelfAssessment: parsed.workerSelfAssessment,
      summary: parsed.summary,
      filesChanged: isRead ? [] : (parsed.filesChanged as string[]),
      findings: isRead ? findings : [],
      citations: isRead ? (parsed.citations as any) : [],
      criteriaSucceeded: isRead ? parsed.criteriaSucceeded : [],
      criteriaErrors: isRead ? parsed.criteriaErrors : [],
      sourcesUsed: parsed.sourcesUsed,
    };

    // Halt only if cap-exhausted AND no structured output
    // (no files, no findings, no citations, no criteriaSucceeded).
    const hasStructuredOutput =
      payload.filesChanged.length > 0 ||
      payload.findings.length > 0 ||
      payload.citations.length > 0 ||
      payload.criteriaSucceeded.length > 0;

    if (
      (turn.stopReason === 'cost_cap' || turn.stopReason === 'turn_cap') &&
      !hasStructuredOutput
    ) {
      return {
        outcome: 'halt',
        comment: `${turn.stopReason}_exceeded_without_output`,
        payload: defaultImplementPayload('failed'),
        telemetry: tel(t0, turn, turn.stopReason),
      };
    }

    return {
      outcome: 'advance',
      payload,
      telemetry: tel(t0, turn, turn.stopReason ?? 'normal'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: 'halt',
      comment: `implement crashed: ${msg}`,
      payload: defaultImplementPayload('failed'),
      telemetry: {
        stageLabel: 'implement',
        durationMs: Date.now() - t0,
        costUSD: null,
        turnsUsed: 0,
        stopReason: 'transport_error',
      },
    };
  }
}
// v4-compat shim: tests/helpers/bootstrap.ts and a few other call sites use
// `new TaskExecutor(emitter)` and `executor.handler.bind(executor)`. The v5
// stage handler is the bare `implementHandler` function above. This class
// preserves the test-fixture contract while delegating to the v5 handler.
export class TaskExecutor {
  constructor(private _emitter?: unknown) {}
  handler = async (state: LifecycleState): Promise<void> => {
    await implementHandler(state);
  };
}
