// Shared types for the v4 review surface. Replaces findings-schema.ts.

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface AnnotatedFinding {
  id: string;
  claim: string;
  evidence: string;
  evidenceGrounded: boolean;
  category?: string;
  reviewerSeverity?: FindingSeverity;
  annotatorConfidence: number | null;
  suggestion?: string;
}

export type ReviewerVerdict = 'approved' | 'changes_required';
export type AnnotatorVerdict = 'annotated' | 'error';
export type DiffReviewerVerdict = 'approve' | 'concerns' | 'reject';
