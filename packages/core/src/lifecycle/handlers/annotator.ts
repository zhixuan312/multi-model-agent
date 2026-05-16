// v4.4.x — unified Annotating stage.
//
// Pure transform: builds the canonical StructuredReport from
// state.lastRunResult, the Review stage's verdict + concerns, the
// Rework flag, and the Committing stage's outcome. Same handler for
// read and write routes — route-specific fields hold empty arrays /
// nulls on the other side so the orchestrator parses one shape.

import type { LifecycleState } from '../stage-plan-types.js';
import { mergeStageStats } from '../merge-stage-stats.js';
import {
  parseSourcesUsed,
  type ResearchSourcesUsedEntry,
} from '../../reporting/report-parser-slots/research-report.js';
import { applyAnnotatePreconditions } from '../annotate-parser.js';
import { annotatePromptWrite, annotatePromptRead } from '../annotate-prompts.js';
import { runAnnotatorTurn } from '../../providers/run-annotator-turn.js';
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
  validationsRun: { name: string; passed: boolean; output: string }[];
  commitSha: string | null;
  commitMessage: string | null;
  commitSkipReason: string | null;
  findings: { severity: string; category: string; claim: string; evidence?: string; suggestion?: string }[];
  criteriaErrors: { criterionId: string; error: string }[];
  /** Research-only: parsed `## Sources used` markdown table. Absent on
   *  every other route (audit/review/debug/investigate/write routes). */
  sourcesUsed?: ResearchSourcesUsedEntry[];
}

export async function annotator(state: LifecycleState): Promise<StageGate<AnnotatePayload>> {
  const t0 = Date.now();
  const last = ((state.lastRunResult as Record<string, unknown> | undefined) ?? {});
  const route = (state as { route?: string }).route;
  const isRead = !!route && READ_ROUTES.has(route);

  const findings = (last.findings as StructuredReport['findings'] | undefined) ?? [];
  const summary = (last.summary as string | undefined)
    ?? (isRead ? `produced ${findings.length} findings` : ((last.output as string | undefined) ?? '').slice(0, 200));

  const report: StructuredReport = {
    summary,
    workerStatus: (last.workerStatus as StructuredReport['workerStatus'] | undefined) ?? (isRead ? 'done' : 'failed'),
    unresolved: (last.unresolved as string[] | undefined) ?? [],
    filesChanged: isRead ? [] : ((last.filesChanged as string[] | undefined) ?? []),
    reviewVerdict: isRead ? null : (((state as { reviewVerdict?: StructuredReport['reviewVerdict'] }).reviewVerdict) ?? null),
    reviewConcerns: isRead ? [] : (((state as { reviewConcerns?: string[] }).reviewConcerns) ?? []),
    reworkApplied: isRead ? false : Boolean((state as { reworkApplied?: boolean }).reworkApplied),
    validationsRun: isRead ? [] : ((last.validationsRun as StructuredReport['validationsRun'] | undefined) ?? []),
    commitSha: isRead ? null : ((last.commitSha as string | null | undefined) ?? null),
    commitMessage: isRead ? null : ((last.commitMessage as string | null | undefined) ?? null),
    commitSkipReason: isRead ? null : ((last.commitSkipReason as string | null | undefined) ?? null),
    findings: isRead ? findings : [],
    criteriaErrors: isRead ? ((last.criteriaErrors as StructuredReport['criteriaErrors'] | undefined) ?? []) : [],
  };

  if (route === 'research') {
    const lastOutput = (last.output as string | undefined) ?? '';
    report.sourcesUsed = parseSourcesUsed(lastOutput);
  }

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
  const bus = (state.executionContext as { bus?: { emit: (e: unknown) => void } } | undefined)?.bus;

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

  // Mechanical filesChanged + commitSha derivation (spec §5.7 rule 4)
  const commitGate = state.gates?.['commit'];
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
    bus?.emit({ event: 'annotate_truncation', ts: new Date().toISOString(), tier: 1, droppedFieldCount: droppedEvidenceCount });
  }
  if (tier >= 2) {
    const dropped = truncatedSummary ? 1 : 0;
    truncatedSummary = '';
    bus?.emit({ event: 'annotate_truncation', ts: new Date().toISOString(), tier: 2, droppedFieldCount: dropped });
  }
  if (tier >= 3) {
    // Tier 3 = fallback mode per spec §5.7.3
    fallbackMode = true;
    bus?.emit({ event: 'annotate_truncation', ts: new Date().toISOString(), tier: 3, droppedFieldCount: 0 });
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
      { getSession?: (tier: 'standard' | 'complex') => { send: (p: string, o?: { stageLabel?: string }) => Promise<unknown> } } | undefined;
    if (ctx && typeof ctx.getSession === 'function') {
      const prompt = isRead ? annotatePromptRead(state) : annotatePromptWrite(state);
      const tres = await runAnnotatorTurn({ prompt, ctx: ctx as unknown as Parameters<typeof runAnnotatorTurn>[0]['ctx'], tier: 'standard' });
      if (tres.kind === 'ok') {
        llmCostUSD = tres.costUSD ?? 0;
        llmModel = tres.model;
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
        bus?.emit({ event: 'annotate_llm_transport_error', ts: new Date().toISOString(), message: tres.message, durationMs: tres.ms } as Record<string, unknown>);
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
    toolCallCount: 0,
    costUSD: llmCostUSD,
    durationMs: Date.now() - t0,
    filesReadCount: 0,
    filesWrittenCount: 0,
  }, { tier: llmTurnsUsed > 0 ? 'standard' : null, model: llmModel });
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
