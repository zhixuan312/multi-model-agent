import type { LifecycleState } from '../stage-plan-types.js';
import type { ComposePayload, StageGate, StageStopReason, WorkerSelfAssessment } from '../stage-io.js';
import { enrichRuntimeResult } from './enrich-runtime-result.js';

// ─── Compose handler (v5 I/O — pure serialization from state.gates) ───────────

/** Canonical list of 9 stage names, in chain order. */
const STAGE_NAMES = [
  'prepare',
  'register-block',
  'implement',
  'review',
  'rework',
  'commit',
  'annotate',
  'compose',
  'terminal',
] as const;

// ─── Compose path-3 (halt) helpers ───────────────────────────────────────────

function buildHaltFindings(gates: Record<string, StageGate<unknown>>): any[] {
  const out: any[] = [];
  const rg = gates['review'];
  if (rg?.outcome === 'advance') {
    const fp = (rg.payload as { findings?: any[] })?.findings ?? [];
    out.push(...fp);
  }
  const ig = gates['implement'];
  if (ig?.outcome === 'advance') {
    const fp = (ig.payload as { findings?: any[] })?.findings ?? [];
    out.push(...fp);
  }
  return out;
}

function buildHaltSummary(gates: Record<string, StageGate<unknown>>): string {
  const wg = gates['rework'];
  if (wg?.outcome === 'advance') {
    return (wg.payload as { summary?: string })?.summary ?? '';
  }
  const ig = gates['implement'];
  if (ig?.outcome === 'advance') {
    return (ig.payload as { summary?: string })?.summary ?? '';
  }
  return '';
}

function buildHaltFilesChanged(gates: Record<string, StageGate<unknown>>): string[] {
  const cg = gates['commit'];
  if (cg?.outcome === 'advance' && (cg.payload as { kind?: string }).kind === 'committed') {
    return (cg.payload as { filesChanged?: string[] })?.filesChanged ?? [];
  }
  return [];
}

function buildHaltCommitSha(gates: Record<string, StageGate<unknown>>): string | null {
  const cg = gates['commit'];
  if (cg?.outcome === 'advance' && (cg.payload as { kind?: string }).kind === 'committed') {
    return (cg.payload as { commitSha?: string })?.commitSha ?? null;
  }
  return null;
}


function makeComposeTelemetry(state: LifecycleState) {
  const gates = state.gates ?? {};

  let totalDurationMs = 0;
  let totalCostUSD: number | null = null;
  let workerSelfAssessment: WorkerSelfAssessment | null = null;
  let reviewVerdict: 'approved' | 'changes_required' | null = null;
  let commitOutcome: 'committed' | 'no_op' | 'not_applicable' = 'not_applicable';
  let stopReason: StageStopReason = 'normal';
  let haltedStage: string | null = null;

  for (const gate of Object.values(gates)) {
    totalDurationMs += gate.telemetry.durationMs ?? 0;
    const c = gate.telemetry.costUSD;
    if (c !== null && c !== undefined) {
      totalCostUSD = (totalCostUSD ?? 0) + c;
    }
    if (gate.telemetry.stopReason !== 'normal' && stopReason === 'normal') {
      stopReason = gate.telemetry.stopReason as StageStopReason;
    }
    if (gate.outcome === 'halt' && haltedStage === null) {
      haltedStage = gate.telemetry.stageLabel;
    }
  }

  // workerSelfAssessment: latest of (rework ?? implement)
  const reworkSa = (gates['rework']?.payload as { workerSelfAssessment?: WorkerSelfAssessment } | null)?.workerSelfAssessment;
  const implSa = (gates['implement']?.payload as { workerSelfAssessment?: WorkerSelfAssessment } | null)?.workerSelfAssessment;
  workerSelfAssessment = reworkSa ?? implSa ?? null;

  // reviewVerdict from review gate
  const reviewGate = gates['review'];
  if (reviewGate?.outcome === 'advance') {
    reviewVerdict = (reviewGate.payload as { verdict?: 'approved' | 'changes_required' }).verdict ?? null;
  }

  // commitOutcome
  const commitGate = gates['commit'];
  if (commitGate?.outcome === 'advance') {
    const cp = commitGate.payload as { kind?: string };
    commitOutcome = cp.kind === 'committed' ? 'committed' : 'no_op';
  }

  // Build telemetry.stages: always 9 entries
  const stages = STAGE_NAMES.map((name) => {
    const gate = gates[name];
    if (!gate) {
      return { name, outcome: 'not_run' as const, durationMs: 0, costUSD: null };
    }
    return {
      name,
      outcome: gate.outcome as 'advance' | 'skip' | 'halt',
      comment: gate.comment,
      durationMs: gate.telemetry.durationMs,
      costUSD: gate.telemetry.costUSD,
    };
  });

  return { totalDurationMs, totalCostUSD, workerSelfAssessment, reviewVerdict, commitOutcome, stopReason, haltedStage, stages };
}

/**
 * v5 compose: pure serialization of the wire envelope from state.gates.
 * Four paths (spec §5.8):
 *  1. normal — annotate.payload copied verbatim
 *  2. register-block — synthesize from register-block gate
 *  3. pre-annotate halt — synthesize from halting gate
 *  4. internal_state_corrupted — degenerate fallback
 */
export async function composeHandler(state: LifecycleState): Promise<StageGate<ComposePayload>> {
  const t0 = Date.now();
  const route = state.route ?? '';
  const gates = state.gates ?? {};
  const halted = state.halted === true;
  const annotateGate = gates['annotate'];

  let payload: ComposePayload;

  if (route === 'register-context-block') {
    // Path 2 — register-block synthesis
    const rbGate = gates['register-block'];
    const rbPayload = rbGate?.payload as { blockId?: string; bytes?: number } | null;
    const blockId: string | null = rbPayload?.blockId ?? null;
    payload = {
      completed: rbGate?.outcome === 'advance',
      message: rbGate?.outcome === 'advance'
        ? `Context block ${blockId} registered (${rbPayload?.bytes ?? 0} bytes)`
        : `Block registration failed: ${rbGate?.comment ?? 'unknown'}`,
      findings: [],
      summary: '',
      filesChanged: [],
      commitSha: null,
      blockId,
      telemetry: makeComposeTelemetry(state),
    };
  } else if (annotateGate?.outcome === 'advance') {
    // Path 1 — normal (annotate ran)
    // AnnotatePayload has 6 fields; ComposePayload adds `blockId` + `telemetry`.
    // Explicitly set blockId=null for non-register routes so the wire shape is
    // complete (not undefined).
    const ap = annotateGate.payload as { completed: boolean; message: string; findings: ComposePayload['findings']; summary: string; filesChanged: string[]; commitSha: string | null };
    payload = {
      completed: ap.completed,
      message: ap.message,
      findings: ap.findings,
      summary: ap.summary,
      filesChanged: ap.filesChanged,
      commitSha: ap.commitSha,
      blockId: null,
      telemetry: makeComposeTelemetry(state),
    };
  } else if (halted) {
    // Path 3 — pre-annotate halt synthesis
    const haltedEntry = Object.values(gates).find(g => g.outcome === 'halt');
    const haltedStageName = haltedEntry?.telemetry.stageLabel ?? 'unknown';
    payload = {
      completed: false,
      message: `${haltedStageName} halted: ${haltedEntry?.comment ?? 'unknown halt'}`,
      findings: buildHaltFindings(gates),
      summary: buildHaltSummary(gates),
      filesChanged: buildHaltFilesChanged(gates),

      commitSha: buildHaltCommitSha(gates),

      blockId: (gates['register-block']?.outcome === 'advance'
        ? ((gates['register-block'].payload as { blockId?: string })?.blockId ?? null)
        : null) as string | null,
      telemetry: makeComposeTelemetry(state),
    };
  } else {
    // Path 4 — internal_state_corrupted degenerate fallback
    payload = {
      completed: false,
      message: 'internal_state_corrupted',
      findings: [],
      summary: '',
      filesChanged: [],
      commitSha: null,
      blockId: null,
      telemetry: {
        totalDurationMs: 0,
        totalCostUSD: null,
        workerSelfAssessment: null,
        reviewVerdict: null,
        commitOutcome: 'not_applicable',
        stopReason: 'transport_error' as StageStopReason,
        haltedStage: null,
        stages: STAGE_NAMES.map(name => ({ name, outcome: 'not_run' as const, durationMs: 0, costUSD: 0 })),
      },
    };
  }

  // Back-compat enrichment: populate v4-shape fields on state.lastRunResult
  // so terminal handlers, recorder, headline composer, and the per-task
  // wire envelope all see the runtime mirror the legacy composeResponse
  // produced. See enrich-runtime-result.ts.
  enrichRuntimeResult(state);

  return {
    outcome: 'advance',
    payload,
    telemetry: {
      stageLabel: 'compose',
      durationMs: Date.now() - t0,
      costUSD: null,
      turnsUsed: 0,
      stopReason: 'normal',
    },
  };
}
