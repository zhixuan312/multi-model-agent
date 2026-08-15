import { describe, it, expect } from 'vitest';
import {
  extractReviewerFindings,
  findingCategories,
  deriveFindingsOutcome,
  FINDINGS_ROUTES,
} from '../../packages/server/src/application/reviewer-findings.js';
import { REFINER_SCHEMAS } from '../../packages/core/src/unified/refiner-schemas.js';

/**
 * The regression these cover: `buildEnvelopeSnapshot` hardcoded `findings: []`,
 * so from 4.8.0 (2026-06-14) onward every event reported `concernCount: 0` and
 * an all-zero severity histogram — 19,580 findings in the corpus before that
 * date, none after. A zero that means "not measured" is worse than a missing
 * field, because it reads as a clean bill of health.
 */
describe('extractReviewerFindings', () => {
  it('reads the refiner`s `weight` as the envelope`s `severity`', () => {
    // The rename is the whole trap. Six refiner schemas call the field `weight`
    // and the envelope calls it `severity`, so a plain cast produces findings
    // with `severity: undefined` that bucket into nothing — the histogram stays
    // all-zero while `concernCount` climbs, which is worse than either alone.
    const out = extractReviewerFindings({
      findings: [{ weight: 'critical', category: 'security', claim: 'c', evidence: 'e' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('critical');
  });

  it('buckets every severity the refiner schemas can emit', () => {
    const out = extractReviewerFindings({
      findings: [
        { weight: 'critical', category: 'security', claim: 'a', evidence: 'e' },
        { weight: 'high', category: 'correctness', claim: 'b', evidence: 'e' },
        { weight: 'medium', category: 'perf', claim: 'c', evidence: 'e' },
        { weight: 'low', category: 'style', claim: 'd', evidence: 'e' },
      ],
    });
    expect(out.map((f) => f.severity)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('keeps the reviewer`s own category word instead of flattening it', () => {
    // `flaky_test` is not one of the 14 ConcernCategory values. Under the old
    // closed enum it became `other`, discarding the signal exactly where it got
    // specific enough to act on.
    const out = extractReviewerFindings({
      findings: [{ weight: 'low', category: 'flaky_test', claim: 'c', evidence: 'e' }],
    });
    expect(out[0]!.category).toBe('flaky_test');
  });

  it('returns nothing for output that carries no findings array', () => {
    // Write routes (delegate, spec, plan, execute_plan) have no `findings` in
    // their refiner schema at all.
    expect(extractReviewerFindings({ status: 'done', notes: '' })).toEqual([]);
    expect(extractReviewerFindings(null)).toEqual([]);
    expect(extractReviewerFindings(undefined)).toEqual([]);
    expect(extractReviewerFindings('a plain string')).toEqual([]);
    expect(extractReviewerFindings({ findings: 'not an array' })).toEqual([]);
  });

  it('skips malformed entries rather than throwing on them', () => {
    // The pipeline downgrades an unparseable reviewer to done_with_concerns and
    // keeps the implementer's answer. Telemetry must not be the thing that then
    // fails the task — a thrown projection loses the whole event.
    const out = extractReviewerFindings({
      findings: [
        null,
        'string',
        { category: 'security' },                       // no weight at all
        { weight: 'catastrophic', claim: 'c' },         // weight outside the enum
        { weight: 'high', category: 'security', claim: 'ok', evidence: 'e' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.claim).toBe('ok');
  });

  it('gives every finding a distinct id', () => {
    const out = extractReviewerFindings({
      findings: [
        { weight: 'low', category: 'a', claim: 'x', evidence: 'e' },
        { weight: 'low', category: 'a', claim: 'y', evidence: 'e' },
      ],
    });
    expect(new Set(out.map((f) => f.id)).size).toBe(2);
  });

  /**
   * The contract test. `FINDINGS_ROUTES` decides whether zero findings means
   * "clean" or "not applicable", and it is a hand-written list — so it is
   * checked against the schemas it claims to describe rather than trusted.
   */
  it('names exactly the task types whose refiner schema has a findings array', () => {
    const withFindings = Object.entries(REFINER_SCHEMAS)
      .filter(([name]) => name !== 'journal_record_decision')
      .filter(([, schema]) => {
        const shape = (schema as { shape?: Record<string, unknown> }).shape;
        return shape !== undefined && 'findings' in shape;
      })
      .map(([name]) => name);
    expect([...FINDINGS_ROUTES].sort()).toEqual(withFindings.sort());
  });
});

describe('findingCategories', () => {
  it('de-duplicates and preserves first-seen order', () => {
    const out = findingCategories(
      extractReviewerFindings({
        findings: [
          { weight: 'low', category: 'perf', claim: 'a', evidence: 'e' },
          { weight: 'low', category: 'security', claim: 'b', evidence: 'e' },
          { weight: 'low', category: 'perf', claim: 'c', evidence: 'e' },
        ],
      }),
    );
    expect(out).toEqual(['perf', 'security']);
  });

  it('stays within the wire`s bound when a reviewer emits many categories', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      weight: 'low' as const, category: `cat_${i}`, claim: 'c', evidence: 'e',
    }));
    expect(findingCategories(extractReviewerFindings({ findings: many })).length).toBeLessThanOrEqual(16);
  });
});

describe('deriveFindingsOutcome', () => {
  const one = extractReviewerFindings({
    findings: [{ weight: 'high', category: 'security', claim: 'c', evidence: 'e' }],
  });

  it('separates "looked and found nothing" from "never looked"', () => {
    // The distinction the whole dashboard column rests on: an audit reporting
    // zero has been reviewed and came back clean; a delegate run reporting zero
    // was never reviewed for quality at all. Both were 0 before v7.
    expect(deriveFindingsOutcome([], true, true)).toBe('clean');
    expect(deriveFindingsOutcome([], true, false)).toBe('not_applicable');
  });

  it('is not_applicable when no reviewer ran, even on a findings route', () => {
    // reviewPolicy: 'none' is a legitimate per-call choice, not a clean result.
    expect(deriveFindingsOutcome([], false, true)).toBe('not_applicable');
  });

  it('reports found when the reviewer raised something', () => {
    expect(deriveFindingsOutcome(one, true, true)).toBe('found');
  });
});

/**
 * Three defects an `audit` run of this very module found, all of the same
 * class: a value that exceeds a wire bound makes
 * `ValidatedTaskCompletedEventSchema.parse()` throw, TelemetryUploader catches
 * it, and the ENTIRE event is dropped. Losing one task's whole telemetry
 * because its reviewer was unusually thorough is the worst available trade, so
 * every one of these clamps rather than rejects.
 */
describe('the extractor cannot produce a record the wire will reject', () => {
  it('truncates a category longer than the wire`s 64-char bound', () => {
    const long = 'x'.repeat(200);
    const out = extractReviewerFindings({
      findings: [{ weight: 'high', category: long, claim: 'c', evidence: 'e' }],
    });
    expect(out[0]!.category).toHaveLength(64);
  });

  it('caps the findings list at the wire`s concernCount bound', () => {
    // 150 is the schema max. A reviewer emitting 400 findings used to take the
    // whole event down with it.
    const many = Array.from({ length: 400 }, (_, i) => ({
      weight: 'low' as const, category: 'style', claim: `c${i}`, evidence: 'e',
    }));
    expect(extractReviewerFindings({ findings: many })).toHaveLength(150);
  });

  it('does not call an UNPARSEABLE review clean', () => {
    // The pipeline sets `reviewerTurn` whether or not the output parsed, so
    // `reviewerRan` alone cannot tell "reviewed, found nothing" from "the
    // review was unreadable". Reporting the second as `clean` is a false
    // assurance about code nobody successfully reviewed.
    expect(deriveFindingsOutcome([], true, true, false)).toBe('not_applicable');
    expect(deriveFindingsOutcome([], true, true, true)).toBe('clean');
  });

  it('still reports findings that WERE parsed out of a partly bad review', () => {
    // A parse error does not erase what was recovered — `found` beats the
    // unparsed downgrade, because the findings in hand are real.
    const one = extractReviewerFindings({
      findings: [{ weight: 'high', category: 'security', claim: 'c', evidence: 'e' }],
    });
    expect(deriveFindingsOutcome(one, true, true, false)).toBe('found');
  });
});
