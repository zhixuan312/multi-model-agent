import { assembleAnnotatorPrompt } from './annotator-prompt-builder.js';
import type { AnnotatorPromptContext } from './templates/annotator-shared.js';
import { annotatorAuditTemplate } from './templates/annotator-audit.js';
import { annotatorReviewTemplate } from './templates/annotator-review.js';
import { annotatorVerifyTemplate } from './templates/annotator-verify.js';
import { annotatorDebugTemplate } from './templates/annotator-debug.js';
import { annotatorInvestigateTemplate } from './templates/annotator-investigate.js';

export function buildAuditQualityPrompt(ctx: AnnotatorPromptContext): string {
  return assembleAnnotatorPrompt(annotatorAuditTemplate, ctx);
}

export function buildReviewQualityPrompt(ctx: AnnotatorPromptContext): string {
  return assembleAnnotatorPrompt(annotatorReviewTemplate, ctx);
}

export function buildVerifyQualityPrompt(ctx: AnnotatorPromptContext): string {
  return assembleAnnotatorPrompt(annotatorVerifyTemplate, ctx);
}

export function buildInvestigateQualityPrompt(ctx: AnnotatorPromptContext): string {
  return assembleAnnotatorPrompt(annotatorInvestigateTemplate, ctx);
}

export function buildDebugQualityPrompt(ctx: AnnotatorPromptContext): string {
  return assembleAnnotatorPrompt(annotatorDebugTemplate, ctx);
}
