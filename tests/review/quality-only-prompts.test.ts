import { describe, expect, it } from 'vitest';
import {
  buildAuditQualityPrompt,
  buildReviewQualityPrompt,
  buildVerifyQualityPrompt,
  buildInvestigateQualityPrompt,
  buildDebugQualityPrompt,
} from '../../packages/core/src/review/quality-only-prompts.js';

describe('quality-only review prompts', () => {
  const buildersAndContexts: Array<[string, (ctx: any) => string]> = [
    ['audit', buildAuditQualityPrompt],
    ['review', buildReviewQualityPrompt],
    ['verify', buildVerifyQualityPrompt],
    ['investigate', buildInvestigateQualityPrompt],
    ['debug', buildDebugQualityPrompt],
  ];

  for (const [name, builder] of buildersAndContexts) {
    it(`${name} prompt includes the schema-parse-failure preamble`, () => {
      const prompt = builder({ workerOutput: 'x', brief: 'y' } as any);
      expect(prompt).toMatch(/well-formed `findings\[\]` array/i);
      expect(prompt).toMatch(/missing or malformed findings array/i);
    });

    it(`${name} prompt instructs 1-indexed line numbers`, () => {
      const prompt = builder({ workerOutput: 'x', brief: 'y' } as any);
      expect(prompt).toMatch(/1-indexed/i);
    });

    it(`${name} prompt asks the reviewer to return approved or changes_required`, () => {
      const prompt = builder({ workerOutput: 'x', brief: 'y' } as any);
      expect(prompt).toMatch(/approved/);
      expect(prompt).toMatch(/changes_required/);
    });
  }
});
