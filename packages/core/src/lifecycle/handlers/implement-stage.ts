// v4.5 — Implementing stage handler.
// Sends the brief to the route's implementer tier via session.send,
// captures the pre-task HEAD SHA, and returns a StageGate<ImplementPayload>
// containing the worker's structured output plus prose-extracted findings.

import type { LifecycleState } from '../stage-plan-types.js';
import type { StageGate, ImplementPayload, RouteName } from '../stage-io.js';
import { parseWorkerOutput } from '../worker-output-contract.js';
import type { Finding, Citation } from '../stage-io.js';
import { performImplementation } from '../perform-implementation.js';
import { checkOutputTargets } from '../../bounded-execution/file-artifact-check.js';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const READ_ROUTES: RouteName[] = ['audit', 'review', 'debug', 'investigate', 'explore', 'journal-recall'];

export function capturePreTaskState(state: LifecycleState): void {
  // Production wires the cwd onto state.executionContext.cwd, not state.cwd —
  // resolve the fallback (same as git-commit-handler) and persist it onto
  // state.cwd so the downstream getRealFilesChanged() reads the real cwd
  // instead of going inert and falling back to the worker's self-report.
  const cwd = (state.cwd as string | undefined) ?? (state.executionContext as { cwd?: string } | undefined)?.cwd;
  if (!cwd) return;
  (state as { cwd?: string }).cwd = cwd;

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
  if (headResult.status !== 0) return;
  (state as { preTaskHeadSha?: string }).preTaskHeadSha = headResult.stdout.trim();

  const lsResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', windowsHide: true });
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

    // v5: Call performImplementation to orchestrate read or write routes
    // and populate state.lastRunResult.
    await performImplementation(state);

    const result = state.lastRunResult as any;
    if (!result) {
      return {
        outcome: 'halt',
        comment: 'implement halted: no result from performImplementation',
        payload: defaultImplementPayload('failed'),
        telemetry: tel(t0, {}, 'transport_error'),
      };
    }

    // Transform lastRunResult into ImplementPayload for the stage gate.
    // Note: parseWorkerOutput extracts filesChanged from the structured output JSON.
    const parsed = parseWorkerOutput(result.output ?? '');
    // Persist parsedCleanly so enrichRuntimeResult can access it
    (result as any).parsedCleanly = parsed.parsedCleanly;
    const findings: Finding[] = [...(result.findings ?? [])];
    const outputTargets = (ctx as { outputTargets?: string[] }).outputTargets ?? [];
    if (outputTargets.length > 0) {
      let nextId = findings.length + 1;
      try {
        const missing = checkOutputTargets(outputTargets);
        if (missing.length > 0) {
          findings.push({
            id: `F${nextId++}`,
            severity: 'high',
            category: 'missing_output_targets',
            claim: `Task declared ${missing.length} output target(s) that were not produced`,
            evidence: `Missing paths: ${missing.join(', ')}`,
            source: 'implementer',
          });
        }
      } catch (e) {
        findings.push({
          id: `F${nextId++}`,
          severity: 'medium',
          category: 'output_targets_check_failed',
          claim: 'Output-target existence check raised an error',
          evidence: e instanceof Error ? e.message : String(e),
          source: 'implementer',
        });
      }
    }
    const payload: ImplementPayload = {
      // workerSelfAssessment lookup chain matches the rest of the payload
      // composition: prefer the runtime-level `workerStatus` (set by
      // enrich-runtime-result on the read-route path), fall back to the
      // structured JSON block the worker emitted (`parseWorkerOutput`),
      // and only default to 'failed' when neither produced a value. Pre-fix,
      // standard write tasks always read 'failed' because workerStatus is
      // populated by enrichRuntimeResult — which runs AFTER implement-stage.
      workerSelfAssessment: (result.workerStatus
        ?? parsed.workerSelfAssessment
        ?? 'failed') as 'done' | 'failed',
      summary: parsed.summary ?? result.summary ?? '',
      filesChanged: parsed.filesChanged ?? result.filesWritten ?? result.filesChanged ?? [],
      findings,
      citations: (result.citations ?? parsed.citations ?? []) as Citation[],
      criteriaSucceeded: result.criteriaSucceeded ?? parsed.criteriaSucceeded ?? [],
      criteriaErrors: result.criteriaErrors ?? parsed.criteriaErrors ?? [],
      sourcesUsed: result.sourcesUsed ?? parsed.sourcesUsed ?? [],
      parsedCleanly: parsed.parsedCleanly,
      ...(result.findingsOutcome !== undefined && { findingsOutcome: result.findingsOutcome }),
      ...(result.findingsOutcomeReason !== undefined && { findingsOutcomeReason: result.findingsOutcomeReason }),
      ...(result.outcomeInferred !== undefined && { outcomeInferred: result.outcomeInferred }),
      ...(result.outcomeMalformed !== undefined && { outcomeMalformed: result.outcomeMalformed }),
    };

    // Halt ONLY on hard worker error. 'incomplete' (worker hit a cap but
    // still produced output) flows through to subsequent stages so the
    // compose envelope reports the truthful incomplete state — same as
    // the legacy executor's behavior.
    if (result.status === 'error') {
      return {
        outcome: 'halt',
        comment: `implement status: ${result.status}`,
        payload,
        telemetry: tel(t0, result, 'normal'),
      };
    }

    return {
      outcome: 'advance',
      payload,
      telemetry: tel(t0, result, 'normal'),
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
