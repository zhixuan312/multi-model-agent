import type { AnnotatorPromptContext } from './templates/annotator-shared.js';
import { qualityAuditTemplate } from './templates/quality-review-audit.js';
import { qualityReviewTemplate } from './templates/quality-review-review.js';
import { qualityVerifyTemplate } from './templates/quality-review-verify.js';
import { qualityDebugTemplate } from './templates/quality-review-debug.js';
import { qualityInvestigateTemplate } from './templates/quality-review-investigate.js';

function buildFromTemplate(
  template: { systemPrompt: string; buildUserPrompt: (ctx: { workerOutput: string; brief: string }) => string },
  ctx: AnnotatorPromptContext,
): string {
  return `${template.systemPrompt}\n\n${template.buildUserPrompt(ctx)}`;
}

export function buildAuditQualityPrompt(ctx: AnnotatorPromptContext): string {
  return buildFromTemplate(qualityAuditTemplate, ctx);
}

export function buildReviewQualityPrompt(ctx: AnnotatorPromptContext): string {
  return buildFromTemplate(qualityReviewTemplate, ctx);
}

export function buildVerifyQualityPrompt(ctx: AnnotatorPromptContext): string {
  return buildFromTemplate(qualityVerifyTemplate, ctx);
}

export function buildInvestigateQualityPrompt(ctx: AnnotatorPromptContext): string {
  return buildFromTemplate(qualityInvestigateTemplate, ctx);
}

export function buildDebugQualityPrompt(ctx: AnnotatorPromptContext): string {
  return buildFromTemplate(qualityDebugTemplate, ctx);
}
