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

export async function annotator(state: LifecycleState): Promise<void> {
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

  mergeStageStats(state, 'annotating', {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedNonReadTokens: 0,
    turnCount: 0,
    toolCallCount: 0,
    costUSD: 0,
    durationMs: Date.now() - t0,
    filesReadCount: 0,
    filesWrittenCount: 0,
  }, { tier: null, model: null });

  const annotatingStats = (state.lastRunResult as { stageStats?: { annotating?: { outcome?: string; maxIdleMs?: number | null; totalIdleMs?: number | null } } } | undefined)
    ?.stageStats?.annotating;
  if (annotatingStats) {
    annotatingStats.outcome = 'transformed';
    annotatingStats.maxIdleMs = 0;
    annotatingStats.totalIdleMs = 0;
  }
}
