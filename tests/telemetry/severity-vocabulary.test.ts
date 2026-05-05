import { SeverityBin } from '../../packages/core/src/telemetry/types.js';
import { annotatedFindingSchema, reviewerEmittedFindingSchema } from '../../packages/core/src/review/findings-schema.js';

type IfEqual<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

const VALID = ['critical', 'high', 'medium', 'low'] as const;
const INVALID = ['style', 'major', 'minor', 'blocker', 'P0', 'Critical', 'HIGH', '', 'info'];

describe('severity vocabulary contract', () => {
  it('SeverityBin accepts exactly critical/high/medium/low', () => {
    for (const v of VALID) expect(SeverityBin.safeParse(v).success).toBe(true);
    for (const v of INVALID) expect(SeverityBin.safeParse(v).success).toBe(false);
  });

  it('annotatedFindingSchema.severity accepts exactly critical/high/medium/low', () => {
    for (const v of VALID) {
      const sample = { id: 'F1', severity: v, claim: 'x', evidence: 'y'.repeat(20), annotatorConfidence: 80, evidenceGrounded: true };
      expect(annotatedFindingSchema.safeParse(sample).success).toBe(true);
    }
    for (const v of INVALID) {
      const sample = { id: 'F1', severity: v, claim: 'x', evidence: 'y'.repeat(20), annotatorConfidence: 80, evidenceGrounded: true };
      expect(annotatedFindingSchema.safeParse(sample).success).toBe(false);
    }
  });

  it('reviewerEmittedFindingSchema.severity accepts exactly critical/high/medium/low', () => {
    for (const v of VALID) {
      const sample = { id: 'F1', severity: v, claim: 'x', evidence: 'y'.repeat(20), annotatorConfidence: 80 };
      expect(reviewerEmittedFindingSchema.safeParse(sample).success).toBe(true);
    }
    for (const v of INVALID) {
      const sample = { id: 'F1', severity: v, claim: 'x', evidence: 'y'.repeat(20), annotatorConfidence: 80 };
      expect(reviewerEmittedFindingSchema.safeParse(sample).success).toBe(false);
    }
  });

  it('TS exactness: SeverityBin output is union "critical" | "high" | "medium" | "low" (not tuple)', () => {
    type X = ReturnType<typeof SeverityBin.parse>;
    const ok: IfEqual<X, 'critical' | 'high' | 'medium' | 'low'> = true;
    expect(ok).toBe(true);
  });
});
