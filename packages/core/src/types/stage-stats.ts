// Per-stage execution stats — populated by the runner-shell + lifecycle
// handlers and consumed by the telemetry event-builder. Matches spec
// architecture.md `types/stage-plan.ts` slot (per-stage stats are the
// observable surface of stage-plan execution).

export type ReviewVerdict =
  | 'approved' | 'concerns' | 'changes_required' | 'annotated' | 'error' | 'skipped' | 'not_applicable';

/**
 * Stages whose execution we record per-stage stats for.
 *
 * `terminal` is intentionally NOT here — it is a heartbeat-display-only state
 * (signaling "the lifecycle is done") and has no work to time, no model that
 * ran during it, no cost to attribute. `HeartbeatStage` (in `heartbeat.ts`)
 * includes `terminal`; `StageName` does not. If you add another display-only
 * stage in the future, exclude it from `StageName` for the same reason.
 */
export type StageName =
  | 'implementing' | 'review' | 'rework' | 'annotating' | 'committing';

interface BaseStageStats {
  entered:       boolean;
  durationMs:    number | null;
  costUSD:       number | null;
  agentTier:     'standard' | 'complex' | 'main' | null;
  modelFamily:   string | null;
  model:         string | null;
  // Populated by the per-stage idle tracker; null when the stage was never
  // entered (so consumers can distinguish "not run" from "ran with zero
  // activity").
  maxIdleMs:     number | null;
  totalIdleMs:   number | null;
  activityEvents:number | null;
  // Per-stage telemetry metrics — populated at stage completion.
  inputTokens:         number | null;
  outputTokens:        number | null;
  cachedReadTokens:    number | null;
  cachedNonReadTokens: number | null;
  turnCount:           number | null;
  filesWrittenCount:  number | null;
}

// One union member per stage so `Extract<RawStageStats, { stage: 'X' }>` resolves
// to a non-`never` variant for every stage in StageStatsMap below. (A union of
// literal stages on a single member would make Extract fail because the member's
// `stage` field doesn't extend any one literal.)
export type RawStageStats =
  | (BaseStageStats & { stage: 'implementing' })
  | (BaseStageStats & { stage: 'rework' })
  | (BaseStageStats & { stage: 'committing' })
  | (BaseStageStats & {
      stage:      'annotating';
    })
  | (BaseStageStats & {
      stage:      'review';
      verdict:    ReviewVerdict | null;
      roundsUsed: number        | null;
    });

export type StageStatsMap = {
  implementing: Extract<RawStageStats, { stage: 'implementing' }>;
  review:       Extract<RawStageStats, { stage: 'review' }>;
  rework:       Extract<RawStageStats, { stage: 'rework' }>;
  annotating:   Extract<RawStageStats, { stage: 'annotating' }>;
  committing:   Extract<RawStageStats, { stage: 'committing' }>;
};
