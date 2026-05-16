/**
 * Single source of truth for the user-facing lifecycle stage progression.
 *
 * Derived dynamically from `STAGE_PLAN` (the v5 9-stage ordered list) so:
 *   - There's no duplicated stage list in async-dispatch + RunningHeadlineSink.
 *   - Adding/removing a stage in `stage-plan-builder.ts` immediately flows
 *     into the polling headline denominator without a second edit.
 *
 * The denominator counts DISTINCT v5 stage names per route under the
 * "rework-eligible happy path" simulation. Reworks count as their own slot
 * when applicable so the bracket advances when rework runs.
 */
import type { LifecycleState } from './stage-plan-types.js';
import type { ToolCategory } from '../escalation/escalation-policy.js';
import { STAGE_PLAN } from './stage-plan-builder.js';
import type { StageDefinition, RouteName } from './stage-io.js';
import { HUMAN_LABEL } from './stage-labels.js';

/** v5 stage name → human-readable label. `null` = hidden from the user-facing
 *  bracket (the stage runs but doesn't get its own slot in the polling
 *  headline; prepare + register-block + compose are pure plumbing). */
const STAGE_LABELS: Record<string, string | null> = {
  prepare:           null,
  'register-block':  null,
  implement:         HUMAN_LABEL.implementing,
  review:            HUMAN_LABEL.review,
  rework:            HUMAN_LABEL.rework,
  commit:            HUMAN_LABEL.committing,
  annotate:          HUMAN_LABEL.annotating,
  compose:           null,
  terminal:          'Finalizing',
};

/** Tool route → (ToolCategory, default reviewPolicy). Keep in sync with
 *  task-runner.ts:toolCategoryForRoute. */
const ROUTE_PROFILE: Record<string, { category: ToolCategory; reviewPolicy: LifecycleState['reviewPolicy'] }> = {
  delegate:                 { category: 'artifact_producing', reviewPolicy: 'full' },
  'execute-plan':           { category: 'artifact_producing', reviewPolicy: 'full' },
  retry:                    { category: 'artifact_producing', reviewPolicy: 'full' },
  audit:                    { category: 'read_only',          reviewPolicy: 'none' },
  review:                   { category: 'read_only',          reviewPolicy: 'none' },
  debug:                    { category: 'read_only',          reviewPolicy: 'none' },
  investigate:              { category: 'read_only',          reviewPolicy: 'none' },
  research:                 { category: 'read_only',          reviewPolicy: 'none' },
  'register-context-block': { category: 'assist',             reviewPolicy: 'none' },
};

/** Simulated state used to filter STAGE_PLAN's shouldRun predicates so the
 *  denominator reflects the maximum reachable stage set for the route
 *  (the worst-case ramp the user can see). */
function simulatedState(
  route: string,
  category: ToolCategory,
  reviewPolicy: LifecycleState['reviewPolicy'],
): LifecycleState {
  return {
    terminal: false,
    attemptIndex: 0,
    attemptBudget: 7,
    reviewPolicy,
    shutdownInProgress: false,
    route,
    toolCategory: category,
    autoCommit: category === 'artifact_producing',
    readOnlyTask: category === 'read_only',
    reviewVerdict: 'changes_required',
    gates: {
      implement: { outcome: 'advance', payload: { workerSelfAssessment: 'done', filesChanged: ['x'] }, telemetry: { stageLabel: 'implement', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' } },
      review:    { outcome: 'advance', payload: { verdict: 'changes_required' }, telemetry: { stageLabel: 'review', durationMs: 0, costUSD: 0, turnsUsed: 0, stopReason: 'normal' } },
    } as LifecycleState['gates'],
    lastRunResult: { filesWritten: ['x'] } as unknown as LifecycleState['lastRunResult'],
    filesChanged: ['x'],
    halted: false,
  } as unknown as LifecycleState;
}

/** Build the user-facing stage label list for a route by walking STAGE_PLAN
 *  and including each stage whose Layer-1 (applicableRoutes) AND Layer-2
 *  (shouldRun under simulated state) both pass. */
export function stageOrderForRoute(route: string): string[] {
  const profile = ROUTE_PROFILE[route];
  if (!profile) return ['Finalizing'];

  const state = simulatedState(route, profile.category, profile.reviewPolicy);
  const ordered: string[] = [];

  for (const stage of STAGE_PLAN) {
    const def = stage as StageDefinition;
    const applies = def.applicableRoutes === 'all'
      ? true
      : (def.applicableRoutes as readonly string[]).includes(route as RouteName);
    if (!applies) continue;

    let runnable = false;
    try { runnable = def.shouldRun(state).run; } catch { runnable = false; }
    if (!runnable) continue;

    const label = STAGE_LABELS[def.name];
    if (label === null) continue;                                 // hidden from bracket
    const final = label ?? def.name;
    if (!ordered.includes(final)) ordered.push(final);
  }

  return ordered.length > 0 ? ordered : ['Finalizing'];
}

const cache = new Map<string, string[]>();

export const STAGE_ORDER_BY_ROUTE: Record<string, readonly string[]> = new Proxy(
  {},
  {
    get(_target, prop: string): readonly string[] | undefined {
      if (typeof prop !== 'string') return undefined;
      let cached = cache.get(prop);
      if (!cached) {
        cached = stageOrderForRoute(prop);
        cache.set(prop, cached);
      }
      return cached;
    },
  },
) as Record<string, readonly string[]>;

export function normalizeStageLabel(label: string): string {
  return label;
}

export function stageProgress(route: string, stageLabel: string | undefined): string {
  const order = STAGE_ORDER_BY_ROUTE[route];
  if (!order || order.length === 0) return '1/1';
  const total = order.length;
  if (!stageLabel) return `1/${total}`;
  const normalized = normalizeStageLabel(stageLabel);
  const idx = order.indexOf(normalized);
  const oneBased = idx === -1 ? 1 : idx + 1;
  return `${oneBased}/${total}`;
}
