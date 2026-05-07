import { ReviewerEngine } from './reviewer-engine.js';
import { AnnotatorEngine } from './annotator-engine.js';
import { ReviewerPromptBuilder } from './reviewer-prompt-builder.js';
import { specTemplate } from './templates/spec-review.js';
import { qualityAPTemplate } from './templates/quality-review-artifact.js';
import { diffTemplate } from './templates/diff-review.js';
import { qualityAuditTemplate } from './templates/quality-review-audit.js';
import { qualityReviewTemplate } from './templates/quality-review-review.js';
import { qualityVerifyTemplate } from './templates/quality-review-verify.js';
import { qualityDebugTemplate } from './templates/quality-review-debug.js';
import { qualityInvestigateTemplate } from './templates/quality-review-investigate.js';

export function createDefaultReviewerEngine(): ReviewerEngine {
  return new ReviewerEngine(
    new ReviewerPromptBuilder(
      { spec: specTemplate, qualityForAP: qualityAPTemplate, diff: diffTemplate },
      {
        audit: qualityAuditTemplate,
        review: qualityReviewTemplate,
        verify: qualityVerifyTemplate,
        debug: qualityDebugTemplate,
        investigate: qualityInvestigateTemplate,
      },
    ),
  );
}

export function createDefaultAnnotatorEngine(): AnnotatorEngine {
  return new AnnotatorEngine();
}
