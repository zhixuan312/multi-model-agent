import { ReviewerEngine } from './reviewer-engine.js';
import { AnnotatorEngine } from './annotator-engine.js';
import { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
// Pipeline-redesign (4.3.0+): spec/quality-AP/diff templates removed.
// Their callers (spec-chain-handlers, quality-chain-handlers, review-diff-handler)
// were also removed. Read-only route templates remain — they power /audit, /review,
// /debug, /investigate via the parallel-criteria + annotator path
// (separate from the execute-plan / delegate pipeline this redesign affects).
import { specLintTemplate } from './templates/spec-review.js';
import { qualityLintTemplate } from './templates/quality-review.js';
import { qualityAuditTemplate } from './templates/quality-review-audit.js';
import { qualityReviewTemplate } from './templates/quality-review-review.js';
import { qualityDebugTemplate } from './templates/quality-review-debug.js';
import { qualityInvestigateTemplate } from './templates/quality-review-investigate.js';

export function createDefaultReviewerEngine(): ReviewerEngine {
  return new ReviewerEngine(
    new ReviewerPromptBuilder(
      { spec: specLintTemplate, qualityForAP: qualityLintTemplate },
      {
        audit: qualityAuditTemplate,
        review: qualityReviewTemplate,
        debug: qualityDebugTemplate,
        investigate: qualityInvestigateTemplate,
      },
    ),
  );
}

export function createDefaultAnnotatorEngine(): AnnotatorEngine {
  return new AnnotatorEngine();
}
