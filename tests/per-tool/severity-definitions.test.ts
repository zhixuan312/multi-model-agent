import { describe, it, expect } from 'vitest';
import { AUDIT_SUBTYPES } from '../../packages/core/src/tools/audit/subtypes.js';
import { REVIEW_SUBTYPES } from '../../packages/core/src/tools/review/subtypes.js';
import { DEBUG_SUBTYPES } from '../../packages/core/src/tools/debug/subtypes.js';
import { INVESTIGATE_SUBTYPES } from '../../packages/core/src/tools/investigate/subtypes.js';
import { RESEARCH_SUBTYPES } from '../../packages/core/src/tools/research/subtypes.js';
import { qualityLintTemplate } from '../../packages/core/src/review/templates/quality-review.js';
import { specLintTemplate } from '../../packages/core/src/review/templates/spec-review.js';

describe('severity-definitions — all 7 routes/templates have spec §9 definitions verbatim', () => {
  // Severity definitions per spec §9:
  // audit: critical="Blocks executability of the audited doc", high="Significant ambiguity/gap; rework needed", etc.
  // review: critical="Production-breaking on merge", high="Correctness gap surfacing in normal use", etc.
  // etc.

  const tests: Array<{ name: string; semantics: any; expectedDefinitions: Record<string, string> }> = [
    {
      name: 'audit (spec subtype)',
      semantics: AUDIT_SUBTYPES.spec,
      expectedDefinitions: {
        critical: 'Blocks executability of the audited doc',
        high: 'Significant ambiguity/gap; rework needed',
        medium: 'Clarity gap; minor assumption needed',
        low: 'Polish; no behavior change',
      },
    },
    {
      name: 'review',
      semantics: REVIEW_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Production-breaking on merge',
        high: 'Correctness gap surfacing in normal use',
        medium: 'Maintainability/fragility',
        low: 'Style',
      },
    },
    {
      name: 'debug',
      semantics: DEBUG_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Confirmed root cause',
        high: 'Very likely root cause; one step unconfirmed',
        medium: 'Plausible hypothesis',
        low: 'Peripheral observation',
      },
    },
    {
      name: 'investigate',
      semantics: INVESTIGATE_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Direct verbatim citation',
        high: 'Clearly inferable from cited source',
        medium: 'Single interpretation step required',
        low: 'Weak inference',
      },
    },
    {
      name: 'research',
      semantics: RESEARCH_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Primary authoritative source',
        high: 'Strong secondary source',
        medium: 'Tertiary source',
        low: 'Inferred/synthesized',
      },
    },
  ];

  for (const { name, semantics, expectedDefinitions } of tests) {
    it(`${name} has all 4 severity definitions verbatim`, () => {
      expect(semantics.semantics.severityMeanings.critical).toBe(expectedDefinitions.critical);
      expect(semantics.semantics.severityMeanings.high).toBe(expectedDefinitions.high);
      expect(semantics.semantics.severityMeanings.medium).toBe(expectedDefinitions.medium);
      expect(semantics.semantics.severityMeanings.low).toBe(expectedDefinitions.low);
    });
  }

  // LINT templates (spec-review, quality-review)
  describe('spec-review LINT template', () => {
    const expectedDefinitions = {
      critical: 'Plan step missed/wrong such that feature won\'t work',
      high: 'Plan step partially implemented',
      medium: 'Diverges in non-essential ways',
      low: 'Cosmetic drift',
    };

    it('has all 4 severity definitions verbatim in OUTPUT_FORMAT or systemPrompt', () => {
      const fullPrompt = specLintTemplate.systemPrompt;
      expect(fullPrompt).toContain(expectedDefinitions.critical);
      expect(fullPrompt).toContain(expectedDefinitions.high);
      expect(fullPrompt).toContain(expectedDefinitions.medium);
      expect(fullPrompt).toContain(expectedDefinitions.low);
    });
  });

  describe('quality-review LINT template', () => {
    const expectedDefinitions = {
      critical: 'Will break in production',
      high: 'Correctness gap in normal use',
      medium: 'Maintainability/fragility',
      low: 'Style',
    };

    it('has all 4 severity definitions verbatim in OUTPUT_FORMAT or systemPrompt', () => {
      const fullPrompt = qualityLintTemplate.systemPrompt;
      expect(fullPrompt).toContain(expectedDefinitions.critical);
      expect(fullPrompt).toContain(expectedDefinitions.high);
      expect(fullPrompt).toContain(expectedDefinitions.medium);
      expect(fullPrompt).toContain(expectedDefinitions.low);
    });
  });
});
