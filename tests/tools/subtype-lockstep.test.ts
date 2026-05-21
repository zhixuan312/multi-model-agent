import { describe, it, expect } from 'vitest';
import { AUDIT_SUBTYPES } from '../../packages/core/src/tools/audit/subtypes.js';
import { REVIEW_SUBTYPES } from '../../packages/core/src/tools/review/subtypes.js';
import { DEBUG_SUBTYPES } from '../../packages/core/src/tools/debug/subtypes.js';
import { INVESTIGATE_SUBTYPES } from '../../packages/core/src/tools/investigate/subtypes.js';
import { RESEARCH_SUBTYPES } from '../../packages/core/src/tools/research/subtypes.js';

// Invariant: each read-only tool's schema subtype enum must equal the keys of
// its *_SUBTYPES table — exact set equality, no extras, no omissions. A
// mismatch makes resolveSubtypeSpec throw invalid_subtype at dispatch.
// audit's enum is the 4-value set (audit/schema.ts:10); the rest are
// 'default'-only.
const SCHEMA_ENUMS: Record<string, string[]> = {
  audit: ['default', 'plan', 'spec', 'skill'],
  review: ['default'],
  debug: ['default'],
  investigate: ['default'],
  research: ['default'],
};

const SUBTYPE_MAPS: Record<string, Record<string, unknown>> = {
  audit: AUDIT_SUBTYPES,
  review: REVIEW_SUBTYPES,
  debug: DEBUG_SUBTYPES,
  investigate: INVESTIGATE_SUBTYPES,
  research: RESEARCH_SUBTYPES,
};

describe('subtype enum ↔ SUBTYPES keys lockstep (exact set equality)', () => {
  for (const route of Object.keys(SCHEMA_ENUMS)) {
    it(`${route}: schema enum == ${route.toUpperCase()}_SUBTYPES keys`, () => {
      expect(new Set(Object.keys(SUBTYPE_MAPS[route]!))).toEqual(new Set(SCHEMA_ENUMS[route]!));
    });
  }
});
