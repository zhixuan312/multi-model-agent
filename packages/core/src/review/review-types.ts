// Shared types for the v4 review surface.
//
// FindingSeverity lives in reporting/severity.ts — the live event-builder /
// bucketing path. Don't duplicate it here.

export type ReviewerVerdict = 'approved' | 'changes_required';
