// Shared types for the v4 review surface. Replaces findings-schema.ts.

// `critical` matches the ANNOTATOR_RUBRIC prompt (annotator-shared.ts) and
// is what the model actually emits — the type previously omitted it, so
// "critical" findings landed in the wire as untyped strings (still
// counted under findings_critical because the wire reads (c as any).severity,
// but invisible to TS callers). 4.0.3+: type is the source of truth.
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AnnotatedFinding {
  id: string;
  claim: string;
  evidence: string;
  evidenceGrounded: boolean;
  category?: string;
  /** Annotator's final severity judgment (replaces the worker's stated
   *  severity). Field name matches the JSON the LLM emits per
   *  ANNOTATOR_RUBRIC — was previously typed as `reviewerSeverity` which
   *  didn't match the runtime shape, so type-narrowing was a lie. */
  severity?: FindingSeverity;
  annotatorConfidence: number | null;
  suggestion?: string;
}

export type ReviewerVerdict = 'approved' | 'changes_required';
export type AnnotatorVerdict = 'annotated' | 'error';
export type DiffReviewerVerdict = 'approve' | 'concerns' | 'reject';
