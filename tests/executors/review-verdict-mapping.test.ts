import { describe, expect, it } from 'vitest';
import { mapReviewVerdicts } from '../../packages/core/src/executors/_shared/review-verdict-mapping.js';

describe('mapReviewVerdicts', () => {
  it('maps lifecycle approve to envelope approve, roundsUsed=1 when no rework', () => {
    const r = mapReviewVerdicts(
      { specReviewStatus: 'not_applicable', qualityReviewStatus: 'approved', reviewRounds: { spec: 0, quality: 1, metadata: 0, cap: 2 } } as any,
      false,
    );
    expect(r).toEqual({ specReviewVerdict: 'not_applicable', qualityReviewVerdict: 'approved', roundsUsed: 1 });
  });

  it('counts reworks: roundsUsed equals reviewRounds.quality (NOT 1 + that)', () => {
    const r = mapReviewVerdicts(
      { specReviewStatus: 'not_applicable', qualityReviewStatus: 'approved', reviewRounds: { spec: 0, quality: 3, metadata: 0, cap: 2 } } as any,
      false,
    );
    expect(r.roundsUsed).toBe(3);
  });

  it('returns kill-switch sentinels when killSwitchActive is true', () => {
    const r = mapReviewVerdicts({} as any, true);
    expect(r).toEqual({ specReviewVerdict: 'skipped', qualityReviewVerdict: 'skipped', roundsUsed: 0 });
  });

  it('falls back to not_applicable when status fields are undefined', () => {
    const r = mapReviewVerdicts({} as any, false);
    expect(r.specReviewVerdict).toBe('not_applicable');
    expect(r.qualityReviewVerdict).toBe('not_applicable');
    expect(r.roundsUsed).toBe(1);
  });

  it('maps lifecycle annotated → envelope annotated (3.8.1)', () => {
    const r = mapReviewVerdicts(
      { specReviewStatus: 'not_applicable', qualityReviewStatus: 'annotated', reviewRounds: { spec: 0, quality: 1, metadata: 0, cap: 2 } } as any,
      false,
    );
    expect(r).toEqual({ specReviewVerdict: 'not_applicable', qualityReviewVerdict: 'annotated', roundsUsed: 1 });
  });

  it('roundsUsed is 1 for annotated path (no rework loop)', () => {
    const r = mapReviewVerdicts(
      { specReviewStatus: 'not_applicable', qualityReviewStatus: 'annotated', reviewRounds: { spec: 0, quality: 1, metadata: 0, cap: 1 } } as any,
      false,
    );
    expect(r.roundsUsed).toBe(1);
  });
});
