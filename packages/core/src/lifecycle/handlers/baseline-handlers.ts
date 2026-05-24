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
    const last = state.lastRunResult as any;
    const basePayload = {
      completed: rbGate?.outcome === 'advance',
      message: rbGate?.outcome === 'advance'
        ? `Context block ${blockId} registered (${rbPayload?.bytes ?? 0} bytes)`
        : `Block registration failed: ${rbGate?.comment ?? 'unknown'}`,
      findings: [] as ComposePayload['findings'],
      summary: '',
      filesChanged: [] as string[],
      commitSha: null as string | null,
      blockId,
      telemetry: makeComposeTelemetry(state),
    };
    payload = {
      ...basePayload,
      ...(last?.findingsOutcome !== undefined && { findingsOutcome: last.findingsOutcome as 'found' | 'clean' | 'not_applicable' }),
      ...(last?.findingsOutcomeReason && { findingsOutcomeReason: last.findingsOutcomeReason as string | null }),
      ...(last?.outcomeInferred !== undefined && { outcomeInferred: last.outcomeInferred as boolean }),
      ...(last?.outcomeMalformed !== undefined && { outcomeMalformed: last.outcomeMalformed as boolean }),
    };
  } else if (annotateGate?.outcome === 'advance') {
    // Path 1 — normal (annotate ran)
    // AnnotatePayload has 6 fields; ComposePayload adds `blockId` + `telemetry`.
    // Explicitly set blockId=null for non-register routes so the wire shape is
    // complete (not undefined).
    const ap = annotateGate.payload as { completed: boolean; message: string; findings: ComposePayload['findings']; summary: string; filesChanged: string[]; commitSha: string | null };
    const last = state.lastRunResult as any;
    const basePayload = {
      completed: ap.completed,
      message: ap.message,
      findings: ap.findings,
      summary: ap.summary,
      filesChanged: ap.filesChanged,
      commitSha: ap.commitSha,
      blockId: null as string | null,
      telemetry: makeComposeTelemetry(state),
    };
    payload = {
      ...basePayload,
      ...(last?.findingsOutcome !== undefined && { findingsOutcome: last.findingsOutcome as 'found' | 'clean' | 'not_applicable' }),
      ...(last?.findingsOutcomeReason && { findingsOutcomeReason: last.findingsOutcomeReason as string | null }),
      ...(last?.outcomeInferred !== undefined && { outcomeInferred: last.outcomeInferred as boolean }),
      ...(last?.outcomeMalformed !== undefined && { outcomeMalformed: last.outcomeMalformed as boolean }),
    };
  } else if (halted) {
    // Path 3 — pre-annotate halt synthesis
    const haltedEntry = Object.values(gates).find(g => g.outcome === 'halt');
    const haltedStageName = haltedEntry?.telemetry.stageLabel ?? 'unknown';
    const last = state.lastRunResult as any;
    const basePayload = {
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
    payload = {
      ...basePayload,
      ...(last?.findingsOutcome !== undefined && { findingsOutcome: last.findingsOutcome as 'found' | 'clean' | 'not_applicable' }),
      ...(last?.findingsOutcomeReason && { findingsOutcomeReason: last.findingsOutcomeReason as string | null }),
      ...(last?.outcomeInferred !== undefined && { outcomeInferred: last.outcomeInferred as boolean }),
      ...(last?.outcomeMalformed !== undefined && { outcomeMalformed: last.outcomeMalformed as boolean }),
    };
  } else {
    // Path 4 — internal_state_corrupted degenerate fallback
    const last = state.lastRunResult as any;
    const basePayload = {
      completed: false,
      message: 'internal_state_corrupted',
      findings: [] as ComposePayload['findings'],
      summary: '',
      filesChanged: [] as string[],
      commitSha: null as string | null,
      blockId: null as string | null,
      telemetry: {
        totalDurationMs: 0,
        totalCostUSD: null,
        workerSelfAssessment: null,
        reviewVerdict: null,
        commitOutcome: 'not_applicable' as const,
        stopReason: 'transport_error' as StageStopReason,
        haltedStage: null,
        stages: STAGE_NAMES.map(name => ({ name, outcome: 'not_run' as const, durationMs: 0, costUSD: 0 })),
      },
    };
    payload = {
      ...basePayload,
      ...(last?.findingsOutcome !== undefined && { findingsOutcome: last.findingsOutcome as 'found' | 'clean' | 'not_applicable' }),
      ...(last?.findingsOutcomeReason && { findingsOutcomeReason: last.findingsOutcomeReason as string | null }),
      ...(last?.outcomeInferred !== undefined && { outcomeInferred: last.outcomeInferred as boolean }),
      ...(last?.outcomeMalformed !== undefined && { outcomeMalformed: last.outcomeMalformed as boolean }),
    };
  }

  // Back-compat enrichment: populate v4-shape fields on state.lastRunResult
  // so terminal handlers, recorder, headline composer, and the per-task
  // wire envelope all see the runtime mirror the legacy composeResponse
  // produced. See enrich-runtime-result.ts.
  enrichRuntimeResult(state);

  // Bridge the composed findings onto envelope.findings. envelopeToPublicResult
  // (server batch handler) serves env.findings to HTTP callers — without this
  // push, every per-task result has findings:[] regardless of what the worker
  // emitted or the parser extracted. recordFinding exists on the envelope API
  // but had no producer until now. Normalize required envelope fields (id,
  // evidence, source) since parser-emitted findings only set them when present.
  const ctx = state.executionContext as { envelope?: { recordFinding?: (f: unknown) => void; recordSourcesUsed?: (rows: unknown) => void; isSealed?: () => boolean } } | undefined;
  const envelope = ctx?.envelope;
  // research-only: bridge the pack-derived `## Sources used` table (set on
  // lastRunResult by perform-implementation) onto the envelope so the batch
  // handler can surface it in structuredReport.sourcesUsed.
  const sourcesUsed = (state.lastRunResult as { sourcesUsed?: unknown } | undefined)?.sourcesUsed;
  if (envelope?.recordSourcesUsed && !envelope.isSealed?.() && Array.isArray(sourcesUsed) && sourcesUsed.length > 0) {
    try { envelope.recordSourcesUsed(sourcesUsed); } catch { /* sealed mid-call → harmless */ }
  }
  if (envelope?.recordFinding && !envelope.isSealed?.() && Array.isArray(payload.findings)) {
    payload.findings.forEach((f, i) => {
      const fin = f as Partial<{ id: string; severity: string; category: string; claim: string; evidence: string; suggestion: string; source: 'implementer' | 'reviewer' }>;
      try {
        envelope.recordFinding!({
          id: fin.id ?? `F${i + 1}`,
          severity: fin.severity ?? 'medium',
          category: fin.category ?? 'unknown',
          claim: fin.claim ?? '',
          evidence: fin.evidence ?? '',
          ...(fin.suggestion !== undefined && { suggestion: fin.suggestion }),
          source: fin.source ?? 'implementer',
        });
      } catch { /* sealed mid-call → harmless */ }
    });
  }

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
