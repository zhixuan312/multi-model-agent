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

/**
 * Read-path back-compat: collapse legacy stage labels that appear in
 * older stored telemetry / batch envelopes into the v4.4.x canonical
 * five-label enum. Live emitters all produce the new vocabulary; this
 * exists for ingest of historical records and stage-stats normalization.
 *
 * Mapping:
 *   spec_review / quality_review / diff_review         → review
 *   criterion_* (any string starting with 'criterion_') → implementing
 *   annotating_retry                                    → annotating
 *   anything else: returned unchanged if it is already a canonical
 *     wire label; otherwise returned unchanged (callers may then
 *     decide to drop or warn).
 */
export function normalizeLegacyStageLabel(label: string): string {
  if (label === 'spec_review' || label === 'quality_review' || label === 'diff_review') return 'review';
  if (label.startsWith('criterion_')) return 'implementing';
  if (label === 'annotating_retry') return 'annotating';
  return label;
}
