import { describe, it, expect } from 'vitest';
import { AUDIT_SUBTYPES } from '../../packages/core/src/tools/audit/subtypes.js';
import { REVIEW_SUBTYPES } from '../../packages/core/src/tools/review/subtypes.js';
import { DEBUG_SUBTYPES } from '../../packages/core/src/tools/debug/subtypes.js';
import { INVESTIGATE_SUBTYPES } from '../../packages/core/src/tools/investigate/subtypes.js';
import { RESEARCH_SUBTYPES } from '../../packages/core/src/tools/research/subtypes.js';
import { buildReadOnlyCachedPrefix } from '../../packages/core/src/tools/read-route-prompt.js';

describe('severity-definitions — all 7 routes/templates have spec §9 definitions verbatim', () => {
  // Severity definitions per spec §9:
  // audit: critical="Blocks executability of the audited doc", high="Significant ambiguity/gap; rework needed", etc.
  // review: critical="Production-breaking on merge", high="Correctness gap surfacing in normal use", etc.
  // etc.

  const tests: Array<{
    name: string;
    subtypeSpec: any;
    expectedDefinitions: Record<string, string>;
  }> = [
    {
      name: 'audit (spec subtype)',
      subtypeSpec: AUDIT_SUBTYPES.spec,
      expectedDefinitions: {
        critical: 'Blocks executability of the audited doc',
        high: 'Significant ambiguity/gap; rework needed',
        medium: 'Clarity gap; minor assumption needed',
        low: 'Polish; no behavior change',
      },
    },
    {
      name: 'review',
      subtypeSpec: REVIEW_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Production-breaking on merge',
        high: 'Correctness gap surfacing in normal use',
        medium: 'Maintainability/fragility',
        low: 'Style',
      },
    },
    {
      name: 'debug',
      subtypeSpec: DEBUG_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Confirmed root cause',
        high: 'Very likely root cause; one step unconfirmed',
        medium: 'Plausible hypothesis',
        low: 'Peripheral observation',
      },
    },
    {
      name: 'investigate',
      subtypeSpec: INVESTIGATE_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Direct verbatim citation',
        high: 'Clearly inferable from cited source',
        medium: 'Single interpretation step required',
        low: 'Weak inference',
      },
    },
    {
      name: 'research',
      subtypeSpec: RESEARCH_SUBTYPES.default,
      expectedDefinitions: {
        critical: 'Primary authoritative source',
        high: 'Strong secondary source',
        medium: 'Tertiary source',
        low: 'Inferred/synthesized',
      },
    },
  ];

  for (const { name, subtypeSpec, expectedDefinitions } of tests) {
    describe(name, () => {
      it('has all 4 severity definitions verbatim in RouteSemantics', () => {
        expect(subtypeSpec.semantics.severityMeanings.critical).toBe(expectedDefinitions.critical);
        expect(subtypeSpec.semantics.severityMeanings.high).toBe(expectedDefinitions.high);
        expect(subtypeSpec.semantics.severityMeanings.medium).toBe(expectedDefinitions.medium);
        expect(subtypeSpec.semantics.severityMeanings.low).toBe(expectedDefinitions.low);
      });

      it('renders severity definitions verbatim in the cached prefix prompt', () => {
        const cachedPrefix = buildReadOnlyCachedPrefix(
          {
            orientation: subtypeSpec.orientation,
            evidenceRule: subtypeSpec.evidenceRule,
            scopeRule: subtypeSpec.scopeRule,
            annotatorAwareness: subtypeSpec.annotatorAwareness,
            criteria: subtypeSpec.criteria,
            findingFormat: '',
            semantics: subtypeSpec.semantics,
          },
          {},
        );
        expect(cachedPrefix).toContain(expectedDefinitions.critical);
        expect(cachedPrefix).toContain(expectedDefinitions.high);
        expect(cachedPrefix).toContain(expectedDefinitions.medium);
        expect(cachedPrefix).toContain(expectedDefinitions.low);
      });
    });
  }
});
