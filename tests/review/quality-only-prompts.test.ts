import { describe, it, expect } from 'vitest';
import {
  buildAuditQualityPrompt,
  buildReviewQualityPrompt,
  buildVerifyQualityPrompt,
  buildInvestigateQualityPrompt,
  buildDebugQualityPrompt,
} from '../../packages/core/src/review/quality-only-prompts.js';

const ctx = {
  workerOutput: '# Worker report\n\nFinding 1: something is wrong at src/foo.ts:42 because the function returns null.\n',
  brief: 'Audit src/foo.ts for correctness.',
};

const ALL_BUILDERS = [
  ['audit', buildAuditQualityPrompt],
  ['review', buildReviewQualityPrompt],
  ['verify', buildVerifyQualityPrompt],
  ['investigate', buildInvestigateQualityPrompt],
  ['debug', buildDebugQualityPrompt],
] as const;

describe('quality-only-prompts (extraction shape)', () => {
  for (const [name, builder] of ALL_BUILDERS) {
    it(`${name}: includes worker output and brief`, () => {
      const prompt = builder(ctx);
      expect(prompt).toContain(ctx.workerOutput);
      expect(prompt).toContain(ctx.brief);
    });

    it(`${name}: instructs reviewer to emit a fenced json code block`, () => {
      const prompt = builder(ctx);
      expect(prompt).toContain('```json');
    });

    it(`${name}: lists all 4 severity tiers including critical`, () => {
      const prompt = builder(ctx);
      expect(prompt).toMatch(/critical/);
      expect(prompt).toMatch(/high/);
      expect(prompt).toMatch(/medium/);
      expect(prompt).toMatch(/low/);
    });

    it(`${name}: instructs reviewer to quote evidence verbatim`, () => {
      const prompt = builder(ctx);
      expect(prompt.toLowerCase()).toMatch(/verbatim/);
    });

    it(`${name}: instructs reviewer to assign id sequentially F1 F2`, () => {
      const prompt = builder(ctx);
      expect(prompt).toMatch(/F1.*F2/s);
    });

    it(`${name}: documents reviewerConfidence range`, () => {
      const prompt = builder(ctx);
      expect(prompt).toMatch(/0-100|0\s*-\s*100/);
    });

    it(`${name}: maps "mid" to "medium"`, () => {
      const prompt = builder(ctx);
      expect(prompt).toMatch(/mid.*medium/i);
    });

    it(`${name}: does NOT mention reviewerSeverity (field removed in 3.10.5)`, () => {
      const prompt = builder(ctx);
      expect(prompt).not.toMatch(/reviewerSeverity/i);
    });
  }
});
