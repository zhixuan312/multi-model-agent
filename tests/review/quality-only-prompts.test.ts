import { describe, expect, it } from 'vitest';
import {
  buildAuditQualityPrompt,
  buildReviewQualityPrompt,
  buildVerifyQualityPrompt,
  buildInvestigateQualityPrompt,
  buildDebugQualityPrompt,
} from '../../packages/core/src/review/quality-only-prompts.js';
import type { WorkerFinding } from '../../packages/core/src/executors/_shared/findings-schema.js';

const SAMPLE_FINDINGS: WorkerFinding[] = [
  {
    id: 'F1',
    severity: 'high',
    claim: 'Missing null check on req.body.user',
    evidence: 'src/auth/login.ts:89 — the access of req.body.user.id is unguarded',
  },
];

const ctx = (route: string) => ({
  workerOutput: 'sample worker output',
  brief: `please ${route} this`,
  workerFindings: SAMPLE_FINDINGS,
});

describe('quality-only review prompts (annotation)', () => {
  const builders: Array<[string, (c: any) => string]> = [
    ['audit', buildAuditQualityPrompt],
    ['review', buildReviewQualityPrompt],
    ['verify', buildVerifyQualityPrompt],
    ['investigate', buildInvestigateQualityPrompt],
    ['debug', buildDebugQualityPrompt],
  ];

  for (const [route, builder] of builders) {
    it(`${route} prompt embeds the rubric for reviewerConfidence (0-100 bands)`, () => {
      const out = builder(ctx(route));
      expect(out).toMatch(/reviewerConfidence/);
      expect(out).toMatch(/0-100/);
      expect(out).toMatch(/80-100/);
      expect(out).toMatch(/0-19/);
    });

    it(`${route} prompt explains reviewerSeverity is only-on-disagreement`, () => {
      const out = builder(ctx(route));
      expect(out).toMatch(/reviewerSeverity/);
      expect(out).toMatch(/disagree|inflate|dial down/i);
    });

    it(`${route} prompt instructs a single \`\`\`json fenced block output`, () => {
      const out = builder(ctx(route));
      expect(out).toMatch(/```json/);
      expect(out).toMatch(/JSON array/i);
    });

    it(`${route} prompt embeds the worker findings as a json block`, () => {
      const out = builder(ctx(route));
      expect(out).toContain('"id": "F1"');
      expect(out).toContain('"severity": "high"');
    });

    it(`${route} prompt does NOT ask for approved/changes_required (no gating)`, () => {
      const out = builder(ctx(route));
      expect(out).not.toMatch(/changes_required/);
      // 'approved' may appear in unrelated context but should not be requested as a verdict
      expect(out).not.toMatch(/return\s+`?approved`?/i);
    });

    it(`${route} prompt names the route's brief context`, () => {
      const out = builder(ctx(route));
      expect(out.toLowerCase()).toContain(route);
    });
  }
});
