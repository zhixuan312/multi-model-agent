/**
 * Single source of truth for the user-facing lifecycle stage progression.
 *
 * Derived dynamically from the actual `StagePlan` so:
 *   - There's no duplicated stage list in async-dispatch + RunningHeadlineSink.
 *   - Adding/removing a row in `stage-plan-builder.ts` immediately flows
 *     into the polling headline denominator without a second edit.
 *   - The denominator naturally matches the rows that have a `schemaStage`
 *     (which is exactly the set of stages that the wire telemetry tracks).
 *
 * The denominator counts DISTINCT schemaStages in plan order, not raw rows
 * — so 3 spec_review rounds collapse into a single "Spec review" slot. The
 * agent sees a stable bracket like `(2/7)` during a 3-round review chain
 * instead of jumping every round.
 *
 * Reworks are kept as their own logical stage when present in the plan
 * (they ARE distinct schemaStages — `spec_rework`, `quality_rework`). When
 * a rework round fires, the bracket advances; when the chain returns to
 * the next review round, it returns to the review slot. This is the
 * accurate behaviour the user asked for: "where are the reworks?"
 *
 * `route → toolCategory` mapping mirrors `task-runner.ts:toolCategoryForRoute`
 * — keep in sync. Both maps live in this module so future contributors see
 * "stage progression for these routes" in one place.
 *
 * Test fixture: tests/lifecycle/stage-plan-builder.test.ts asserts that stageOrderForRoute() denominators stay stable across plan refactors.
 */
import type { ToolCategory } from '../escalation/escalation-policy.js';
import type { LifecycleState } from './stage-plan-types.js';
import { buildStagePlan } from './stage-plan-builder.js';

/** Canonical schemaStage → human-readable label used in `stageLabel` events
 *  emitted by handlers + shown in the polling headline.
 *
 *  Pipeline (4.3.0+, lint+rework split):
 *    Implementing → Review → Rework → Annotating → Committing → Finalizing
 *
 *  Per-route which stages fire:
 *    Read-only:  Implementing → Annotating → Finalizing
 *    Research:   Implementing → Finalizing
 *    Write:      all stages; Rework only when review verdict is changes_required;
 *                Committing conditional on commit-gate threshold. */
const SCHEMA_STAGE_LABELS: Record<string, string> = {
  implementing: 'Implementing',
  review: 'Review',
  rework: 'Rework',
  annotating: 'Annotating',
  committing: 'Committing',
  finalizing: 'Finalizing',
};

/** Tool route → (ToolCategory, default reviewPolicy). Mirrors
 *  task-runner.ts:toolCategoryForRoute + the reviewPolicy each tool-config
 *  injects into TaskSpec. Keep in sync; if these drift, the user-facing
 *  stage bracket will denominator-skew. */
const ROUTE_PROFILE: Record<string, { category: ToolCategory; reviewPolicy: LifecycleState['reviewPolicy'] }> = {
  delegate:                 { category: 'artifact_producing', reviewPolicy: 'full' },
  'execute-plan':           { category: 'artifact_producing', reviewPolicy: 'full' },
  retry:                    { category: 'artifact_producing', reviewPolicy: 'full' },
  audit:                    { category: 'read_only',          reviewPolicy: 'quality_only' },
  review:                   { category: 'read_only',          reviewPolicy: 'quality_only' },
  verify:                   { category: 'read_only',          reviewPolicy: 'quality_only' },
  debug:                    { category: 'read_only',          reviewPolicy: 'quality_only' },
  investigate:              { category: 'read_only',          reviewPolicy: 'quality_only' },
  explore:                  { category: 'research',           reviewPolicy: 'none' },
  research:                 { category: 'research',           reviewPolicy: 'none' },
  'register-context-block': { category: 'assist',             reviewPolicy: 'none' },
};

/** Route-specific label overrides — empty post-redesign because each
 *  route's StagePlan row uses the right schemaStage directly. Kept as a
 *  stub so the lookup in stageOrderForRoute() doesn't need a special case. */
const ROUTE_LABEL_OVERRIDES: Record<string, Record<string, string>> = {};

/** Routes where the StagePlan doesn't include a coarse "Finalizing" row
 *  but we want one in the polling progression so the agent sees a clean
 *  ramp to completion. Appended to the derived list. */
const FINALIZING_LABEL = 'Finalizing';

/** "Rework-possible happy-path" simulated state. Used to filter StagePlan
 *  rows by runCondition so the user-facing denominator only counts stages
 *  that could plausibly fire for this route — not every schemaStage in
 *  the plan. Verdict flags are set to 'changes_required' so rework rows
 *  are eligible (the bracket should reflect the maximum reachable
 *  denominator, not just the happy path). Chain-passed flags are also
 *  set true so post-chain rows (diff_review / verifying / committing)
 *  are eligible too. */
function simulatedStateForRoute(
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
    // lastRunResult truthy + a non-empty filesWritten so post-impl rows
    // that gate on artifacts (e.g. 5.2 git_commit) are eligible.
    lastRunResult: { filesWritten: ['x'] } as unknown as LifecycleState['lastRunResult'],
    filesChanged: ['x'],
    // Only artifact_producing routes commit. Setting these correctly here
    // makes row 5.2 (git_commit) gate off for read_only audit/review/etc.
    autoCommit: category === 'artifact_producing',
    readOnlyTask: category === 'read_only',
    specChainPassed: true,
    qualityChainPassed: true,
    specReviewRound1Verdict: 'changes_required',
    specReviewRound2Verdict: 'changes_required',
    qualityReviewRound1Verdict: 'changes_required',
    qualityReviewRound2Verdict: 'changes_required',
  } as unknown as LifecycleState;
}

/** Build the user-facing stage label list for a route by simulating each
 *  StagePlan row's runCondition under the route's defaults. Distinct
 *  schemaStages whose runCondition returns true become the user-facing
 *  stages, in plan order. Route-specific label overrides + a tail
 *  "Finalizing" slot give the agent a stable bracket. */
export function stageOrderForRoute(route: string): string[] {
  const profile = ROUTE_PROFILE[route];
  if (!profile) return [FINALIZING_LABEL];

  const plan = buildStagePlan(profile.category);
  const state = simulatedStateForRoute(route, profile.category, profile.reviewPolicy);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const overrides = ROUTE_LABEL_OVERRIDES[route] ?? {};

  for (const row of plan.rows) {
    const schema = row.schemaStage;
    if (!schema) continue;
    if (seen.has(schema)) continue;
    // Skip rows whose runCondition wouldn't fire for this route's defaults.
    // E.g. spec_review/spec_rework/diff_review/verifying/committing all
    // gate on `isAP` — they're absent from the read_only audit denominator.
    let eligible = false;
    try { eligible = row.runCondition(state); } catch { eligible = false; }
    if (!eligible) continue;
    seen.add(schema);
    const label = overrides[schema] ?? SCHEMA_STAGE_LABELS[schema] ?? schema;
    ordered.push(label);
  }

  ordered.push(FINALIZING_LABEL);
  return ordered;
}

/** Memoized lookup so async-dispatch + RunningHeadlineSink don't rebuild
 *  the stage plan for every event. The plan is pure-of-state, so the
 *  cache is safe across the daemon's lifetime. */
const cache = new Map<string, string[]>();

/** Public accessor mirroring the legacy `STAGE_ORDER_BY_ROUTE[route]` shape
 *  but driven by the StagePlan. Returns an empty array (treated as "1/1")
 *  for unknown routes. */
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

/** Normalize a runtime stageLabel ("Spec rework round 1") to a coarse
 *  label that exists in `stageOrderForRoute(route)`. Reworks map to their
 *  own coarse slot ("Spec rework" / "Quality rework"), not back to the
 *  review slot — the StagePlan-derived order DOES contain a rework slot
 *  (because spec_rework / quality_rework are distinct schemaStages), so
 *  the bracket advances correctly when a rework fires. */
export function normalizeStageLabel(label: string): string {
  return label;
}

/** "(X/Y)" stage-progress bracket for a route + current stageLabel. */
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
