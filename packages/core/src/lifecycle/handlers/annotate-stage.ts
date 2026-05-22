// v4.4.x — unified Annotating stage.
//
// LLM judge layer (spec §5.7.2), NOT a pure transform: this stage fires a
// real LLM turn on the standard tier (see getSession('standard') below) for
// both read and write routes. The LLM is the PROPOSER — it may set
// completed/message/summary — while the deterministic parser
// (applyAnnotatePreconditions) is the ENFORCER and the mechanical fields
// (findings, filesChanged, commitSha) are always overridden from upstream
// gates. It judges/summarizes the worker's emitted report; it does NOT
// independently re-read the codebase to find defects (that is the Review
// stage, which is write-routes-only). Falls back to mechanical synthesis only
// on tier-3 prompt-budget truncation or after all transport retries fail.
//
// It assembles the canonical StructuredReport from state.lastRunResult, the
// Review stage's verdict + concerns, the Rework flag, and the Committing
// stage's outcome. Same handler for read and write routes — route-specific
// fields hold empty arrays / nulls on the other side so the orchestrator
// parses one shape.

import type { LifecycleState } from '../stage-plan-types.js';
import { mergeStageStats } from '../merge-stage-stats.js';
import { HUMAN_LABEL } from '../stage-labels.js';
import {
  parseSourcesUsed,
  type ResearchSourcesUsedEntry,
} from '../../reporting/report-parser-slots/research-report.js';
import { applyAnnotatePreconditions } from '../annotate-parser.js';
import { annotatePromptWrite, annotatePromptRead } from '../annotate-prompts.js';
import type { AnnotatePayload, StageGate } from '../stage-io.js';

const READ_ROUTES = new Set(['audit', 'review', 'debug', 'investigate', 'research']);

export interface StructuredReport {
  summary: string;
  workerStatus: 'done' | 'done_with_concerns' | 'blocked' | 'failed';
  unresolved: string[];
  filesChanged: string[];
  reviewVerdict: 'approved' | 'changes_required' | null;
  reviewConcerns: string[];
  reworkApplied: boolean;
  commitSha: string | null;
  commitMessage: string | null;
  commitSkipReason: string | null;
  findings: { severity: string; category: string; claim: string; evidence?: string; suggestion?: string }[];
  criteriaErrors: { criterionId: string; error: string }[];
  /** Research-only: parsed `## Sources used` markdown table. Absent on
   *  every other route (audit/review/debug/investigate/write routes). */
  sourcesUsed?: ResearchSourcesUsedEntry[];
  findingsOutcome?: 'found' | 'clean' | 'not_applicable';
  findingsOutcomeReason?: string | null;
  outcomeInferred?: boolean;
  outcomeMalformed?: boolean;
}

export async function annotator(state: LifecycleState): Promise<StageGate<AnnotatePayload>> {
  const t0 = Date.now();
  const last = ((state.lastRunResult as Record<string, unknown> | undefined) ?? {});
  const route = (state as { route?: string }).route;
  const isRead = !!route && READ_ROUTES.has(route);

  const findings = (last.findings as StructuredReport['findings'] | undefined) ?? [];
  const summary = (last.summary as string | undefined)
    ?? (isRead ? `produced ${findings.length} findings` : ((last.output as string | undefined) ?? '').slice(0, 200));

  // Commit fields are authoritative from the commit GATE payload — the commit
  // handler writes the SHA/message/files THERE, not into state.lastRunResult
  // (see git-commit-handler.ts header). Sourcing them from `last` left them
  // perpetually null on the user-facing report, and `last.filesChanged` (a
  // repo-wide diff) leaked sibling workers' files under concurrent dispatch.
  // The committed gate's filesChanged is this worker's own pathspec.
  const commitGate = state.gates?.['commit'];
  const commitPayload = (commitGate?.payload ?? null) as
    { kind?: string; commitSha?: string; commitMessage?: string; filesChanged?: string[]; reason?: string } | null;
  const committed = commitGate?.outcome === 'advance' && commitPayload?.kind === 'committed';

  const report: StructuredReport = {
    summary,
    workerStatus: (last.workerStatus as StructuredReport['workerStatus'] | undefined) ?? (isRead ? 'done' : 'failed'),
    unresolved: (last.unresolved as string[] | undefined) ?? [],
    filesChanged: isRead ? [] : (committed ? (commitPayload?.filesChanged ?? []) : ((last.filesChanged as string[] | undefined) ?? [])),
    reviewVerdict: isRead ? null : (((state as { reviewVerdict?: StructuredReport['reviewVerdict'] }).reviewVerdict) ?? null),
    reviewConcerns: isRead ? [] : (((state as { reviewConcerns?: string[] }).reviewConcerns) ?? []),
    reworkApplied: isRead ? false : Boolean((state as { reworkApplied?: boolean }).reworkApplied),
    commitSha: isRead ? null : (committed ? (commitPayload?.commitSha ?? null) : null),
    commitMessage: isRead ? null : (committed ? (commitPayload?.commitMessage ?? null) : null),
    commitSkipReason: isRead || committed ? null : (commitPayload?.kind === 'no_op' ? (commitPayload?.reason ?? null) : null),
    findings: isRead ? findings : [],
    criteriaErrors: isRead ? ((last.criteriaErrors as StructuredReport['criteriaErrors'] | undefined) ?? []) : [],
  };

  if (route === 'research') {
    const lastOutput = (last.output as string | undefined) ?? '';
    report.sourcesUsed = parseSourcesUsed(lastOutput);
  }

  report.findingsOutcome = (last.findingsOutcome as StructuredReport['findingsOutcome'] | undefined);
  report.findingsOutcomeReason = (last.findingsOutcomeReason as string | null | undefined);
  report.outcomeInferred = (last.outcomeInferred as boolean | undefined);
  report.outcomeMalformed = (last.outcomeMalformed as boolean | undefined);

  (state as { structuredReport?: unknown }).structuredReport = report;

  // v5: prompt-budget truncation per spec §14 assumption 7 + AC-30 to AC-33.
  // Three tiers, applied progressively when config.truncateAnnotatePromptTier
  // signals overflow:
  //   tier 1 → strip Finding.evidence
  //   tier 2 → also strip summary fields (set to '')
  //   tier 3 → fallback mode: emit deterministic AnnotatePayload with verbatim
  //            spec-text message; completed=false; findings passthrough.
  const cfg = (state as { config?: { truncateAnnotatePromptTier?: number } }).config ?? {};
  const tier = cfg.truncateAnnotatePromptTier ?? 0;
  const envelope = (state.executionContext as { envelope?: unknown } | undefined)?.envelope;

  // Aggregate candidate findings from all upstream sources (mirrors §5.7 rule 1
  // and the fallback specifier in §5.7.3). lastRunResult.findings is the read-
  // route worker's emission; gates.review.findings is the reviewer's emission;
  // gates.implement.findings is the read-route implement gate's emission.
  type Fin = AnnotatePayload['findings'][number];
  const reviewGate = state.gates?.['review'];
  const implementGate = state.gates?.['implement'];
  const aggregatedFindings: Fin[] = [
    ...((last.findings as Fin[] | undefined) ?? []),
    ...((reviewGate?.outcome === 'advance' ? (reviewGate.payload as { findings?: Fin[] } | null)?.findings : undefined) ?? []),
    ...((implementGate?.outcome === 'advance' ? (implementGate.payload as { findings?: Fin[] } | null)?.findings : undefined) ?? []),
  ];
  // Dedupe by claim+evidence (preserve first occurrence)
  const seen = new Set<string>();
  const dedupedFindings: Fin[] = [];
  for (const f of aggregatedFindings) {
    const key = `${f.claim ?? ''}|${(f as { evidence?: string }).evidence ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedFindings.push(f);
  }

  // Mechanical filesChanged + commitSha derivation (spec §5.7 rule 4).
  // Reuses the `commitGate` resolved above.
  const mechanicalFilesChanged: string[] =
    commitGate?.outcome === 'advance' &&
    (commitGate.payload as { kind?: string } | null)?.kind === 'committed'
      ? (commitGate.payload as { filesChanged?: string[] }).filesChanged ?? []
      : (isRead ? [] : report.filesChanged);
  const mechanicalCommitSha: string | null =
    commitGate?.outcome === 'advance' &&
    (commitGate.payload as { kind?: string } | null)?.kind === 'committed'
      ? ((commitGate.payload as { commitSha?: string }).commitSha ?? null)
      : (isRead ? null : (report.commitSha ?? null));

  let truncatedFindings = dedupedFindings.slice();
  let truncatedSummary = report.summary;
  let fallbackMode = false;

  if (tier >= 1) {
    const droppedEvidenceCount = truncatedFindings.filter(f => (f as { evidence?: string }).evidence !== undefined).length;
    truncatedFindings = truncatedFindings.map(f => {
      const cp: Fin = { ...f };
      delete (cp as { evidence?: string }).evidence;
      return cp;
    });
    // Annotation truncation is now recorded as a validation warning in the envelope
    const env = envelope as any;
    env?.recordValidationWarning?.({ rule: 'AnnotateTruncationTier1', path: 'annotatePrompt' });
  }
  if (tier >= 2) {
    const dropped = truncatedSummary ? 1 : 0;
    truncatedSummary = '';
    const env = envelope as any;
    env?.recordValidationWarning?.({ rule: 'AnnotateTruncationTier2', path: 'annotatePrompt' });
  }
  if (tier >= 3) {
    // Tier 3 = fallback mode per spec §5.7.3
    fallbackMode = true;
    const env = envelope as any;
    env?.recordValidationWarning?.({ rule: 'AnnotateTruncationTier3', path: 'annotatePrompt' });
  }

  let annotated: AnnotatePayload;
  // LLM judge layer (spec §5.7.2). The annotator stage runs an LLM turn
  // unless tier-3 truncation kicked us into fallback mode. The LLM is the
  // proposer; the deterministic parser is the enforcer — applyAnnotatePreconditions
  // always runs on the LLM-proposed payload and may flip completed=false. On
  // transport error we fall back to mechanical synthesis (same path that ran
  // before this layer was added).
  let llmCostUSD = 0;
  let llmDurationMs = 0;
  let llmTurnsUsed = 0;
  let llmTransportFailed = false;
  let llmModel: string | null = null;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  let llmCachedReadTokens = 0;
  let llmCachedNonReadTokens = 0;
  if (fallbackMode) {
    // Fallback findings: only gate-sourced findings flow through (gates.review,
    // gates.implement). lastRunResult.findings are dropped as part of tier-3
    // citation/non-gate-evidence clearing (spec §5.7.3 / AC-32).
    const fallbackFindings: Fin[] = [];
    const fbSeen = new Set<string>();
    const reviewFindings =
      (reviewGate?.outcome === 'advance' ? (reviewGate.payload as { findings?: Fin[] } | null)?.findings : undefined) ?? [];
    const implementFindings =
      (implementGate?.outcome === 'advance' ? (implementGate.payload as { findings?: Fin[] } | null)?.findings : undefined) ?? [];
    for (const f of [...reviewFindings, ...implementFindings]) {
      const k = `${f.claim ?? ''}|${(f as { evidence?: string }).evidence ?? ''}`;
      if (fbSeen.has(k)) continue;
      fbSeen.add(k);
      const cp: Fin = { ...f };
      delete (cp as { evidence?: string }).evidence;
      fallbackFindings.push(cp);
    }
    annotated = {
      completed: false,
      message: 'annotator prompt budget exceeded after tier-3 truncation; verdict computed mechanically from upstream gates',
      findings: fallbackFindings,
      summary: '',
      filesChanged: mechanicalFilesChanged,
      commitSha: mechanicalCommitSha,
    };
  } else {
    // Default mechanical proposal — used directly when LLM fails or returns
    // unparseable output. The parser still gets the final say either way.
    const mechanical: AnnotatePayload = {
      completed: true,
      message: truncatedSummary || (isRead ? 'investigation completed' : 'task completed'),
      findings: truncatedFindings,
      summary: truncatedSummary,
      filesChanged: mechanicalFilesChanged,
      commitSha: mechanicalCommitSha,
    };

    let proposed: AnnotatePayload = mechanical;
    const ctx = (state as { executionContext?: unknown }).executionContext as
      {
        getSession?: (tier: 'standard' | 'complex') => { send: (p: string, o?: { stageLabel?: string }) => Promise<unknown> };
        providers?: Partial<Record<'standard' | 'complex', { config?: { model?: string } }>>;
      } | undefined;
    // Annotator runs on the standard tier; capture its model from the provider
    // config so the wire row attributes annotate cost+tokens to the real model.
    // TurnResult does not carry model, so (r as any).model below is undefined
    // for every provider — without this lookup the annotate stage's model was
    // always null on the wire even when an LLM call actually fired.
    const annotateModelFromConfig: string | null =
      ctx?.providers?.['standard']?.config?.model ?? null;
    if (ctx && typeof ctx.getSession === 'function') {
      const prompt = isRead ? annotatePromptRead(state) : annotatePromptWrite(state);
      const session = ctx.getSession('standard');
      let tres:
        | { kind: 'ok'; text: string; costUSD: number | null; turnsUsed: number; ms: number; model: string | null; inputTokens: number; outputTokens: number; cachedReadTokens: number; cachedNonReadTokens: number }
        | { kind: 'transport_error'; message: string; ms: number };
      const t0 = Date.now();
      // Retry on transport errors: 3 attempts with 0s, 1s, 2s backoff (AC-19, AC-20)
      const retryDelays = [0, 1000, 2000];
      let lastErr: Error | undefined;
      // Initialize to error; will be overwritten on success or last failure
      tres = { kind: 'transport_error', message: 'annotator transport failed', ms: 0 };
      for (let attempt = 0; attempt < retryDelays.length; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
        try {
          const r = await session.send(prompt, { stageLabel: HUMAN_LABEL.annotating });
          tres = {
            kind: 'ok',
            text: (r as any).output ?? '',
            costUSD: typeof (r as any).costUSD === 'number' ? (r as any).costUSD : null,
            turnsUsed: (r as any).turns ?? 1,
            ms: Date.now() - t0,
            model: (r as any).model ?? null,
            inputTokens: (r as any).usage?.inputTokens ?? 0,
            outputTokens: (r as any).usage?.outputTokens ?? 0,
            cachedReadTokens: (r as any).usage?.cachedReadTokens ?? 0,
            cachedNonReadTokens: (r as any).usage?.cachedNonReadTokens ?? 0,
          };
          break; // Success, exit retry loop
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          // Update error message for next retry or final failure
          tres = { kind: 'transport_error', message: lastErr.message, ms: Date.now() - t0 };
        }
      }
      if (tres.kind === 'ok') {
        llmCostUSD = tres.costUSD ?? 0;
        // TurnResult does not carry model — fall back to the provider config
        // we captured above (tres.model is undefined for every provider).
        llmModel = tres.model ?? annotateModelFromConfig;
        llmDurationMs = tres.ms;
        llmTurnsUsed = tres.turnsUsed;
        llmInputTokens = tres.inputTokens;
        llmOutputTokens = tres.outputTokens;
        llmCachedReadTokens = tres.cachedReadTokens;
        llmCachedNonReadTokens = tres.cachedNonReadTokens;
        const parsed = extractAnnotateJson(tres.text);
        if (parsed) {
          // Authoritative fields come from upstream gates (mechanicalFilesChanged,
          // mechanicalCommitSha, dedupedFindings). The LLM gets to propose
          // completed + message + summary; everything mechanical we override.
          proposed = {
            completed: typeof parsed.completed === 'boolean' ? parsed.completed : mechanical.completed,
            message: typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : mechanical.message,
            summary: typeof parsed.summary === 'string' ? parsed.summary : mechanical.summary,
            findings: truncatedFindings,
            filesChanged: mechanicalFilesChanged,
            commitSha: mechanicalCommitSha,
          };
        }
        // parsed === null → keep mechanical (parser unaffected)
      } else {
        // transport_error — fall through to mechanical synthesis
        llmTransportFailed = true;
        llmDurationMs = tres.ms;
        // Transport errors are now recorded as validation warnings
        const env = envelope as any;
        env?.recordValidationWarning?.({ rule: 'AnnotateLLMTransportError', path: 'annotatePrompt' });
      }
    }
    annotated = applyAnnotatePreconditions(proposed, state);
  }
  (state as { annotatePayload?: AnnotatePayload }).annotatePayload = annotated;

  mergeStageStats(state, 'annotating', {
    inputTokens: llmInputTokens,
    outputTokens: llmOutputTokens,
    cachedReadTokens: llmCachedReadTokens,
    cachedNonReadTokens: llmCachedNonReadTokens,
    turnCount: llmTurnsUsed,
    costUSD: llmCostUSD,
    durationMs: Date.now() - t0,
    filesWrittenCount: 0,
  }, {
    tier: llmTurnsUsed > 0 ? 'standard' : null,
    model: llmModel,
    // Mirror the outcome the implementer (or reviewer) computed so the
    // annotating stage row carries the same value downstream consumers see.
    findingsOutcome: (last.findingsOutcome as 'found' | 'clean' | 'not_applicable' | undefined),
    findingsOutcomeReason: (last.findingsOutcomeReason as string | null | undefined),
    outcomeInferred: (last.outcomeInferred as boolean | undefined),
    outcomeMalformed: (last.outcomeMalformed as boolean | undefined),
  });
  // suppress unused-variable warning while keeping the durationMs field for
  // diagnostics callers; mergeStageStats already captured the value above.
  void llmDurationMs;
  void llmTransportFailed;

  const annotatingStats = (state.lastRunResult as { stageStats?: { annotating?: { outcome?: string; maxIdleMs?: number | null; totalIdleMs?: number | null } } } | undefined)
    ?.stageStats?.annotating;
  if (annotatingStats) {
    annotatingStats.outcome = 'transformed';
    annotatingStats.maxIdleMs = 0;
    annotatingStats.totalIdleMs = 0;
  }

  return {
    outcome: 'advance',
    payload: annotated,
    telemetry: {
      stageLabel: 'annotate',
      durationMs: Date.now() - t0,
      costUSD: llmCostUSD,
      turnsUsed: llmTurnsUsed,
      stopReason: 'normal',
    },
  };
}

/**
 * Extract a single JSON object from the LLM's response.
 *
 * Accepts:
 *   - A fenced ```json …``` block (preferred form per annotate prompts)
 *   - A fenced ``` …``` block (no language tag)
 *   - The first balanced `{…}` substring in the text
 *
 * Returns `null` if no parseable JSON is found, signalling the caller to keep
 * the mechanical proposal. This is intentional: a malformed LLM response
 * should not cause stage failure — the parser already has a deterministic
 * answer it can fall back on.
 */
function extractAnnotateJson(text: string): { completed?: unknown; message?: unknown; summary?: unknown } | null {
  if (!text) return null;
  const fencedJson = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  const candidate = fencedJson ? fencedJson[1] : firstBalancedBraces(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as { completed?: unknown; message?: unknown; summary?: unknown };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function firstBalancedBraces(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
