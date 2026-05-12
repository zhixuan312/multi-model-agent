// v4.4.x — single source of truth for lifecycle stage labels.
//
// Five canonical wire labels (snake_case) ↔ five human-readable labels.
// Every emitter of `stageLabel` reads from HUMAN_LABEL; every wire
// consumer reads from WIRE_LABEL. The legacy labels (spec_review,
// quality_review, diff_review, criterion_*, annotating_retry) are
// mapped via stage-stats normalizer at the read path, not here.

export const STAGE_LABELS = ['implementing', 'review', 'rework', 'committing', 'annotating'] as const;
export type StageLabel = (typeof STAGE_LABELS)[number];

/** Wire enum (snake_case) → human-readable label. */
export const HUMAN_LABEL: Record<StageLabel, string> = {
  implementing: 'Implementing',
  review: 'Review',
  rework: 'Rework',
  committing: 'Committing',
  annotating: 'Annotating',
};

/** Human-readable label → wire enum. */
export const WIRE_LABEL: Record<string, StageLabel> = Object.fromEntries(
  STAGE_LABELS.map((wire) => [HUMAN_LABEL[wire], wire])
) as Record<string, StageLabel>;
