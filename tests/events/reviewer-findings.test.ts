import { describe, it, expect } from 'vitest';
import {
  ReviewStageEntrySchema,
  CONCERN_CATEGORY_MAX_LEN,
  CONCERN_CATEGORIES_MAX,
  CONCERN_COUNT_MAX,
} from '../../packages/core/src/events/wire-schema.js';
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
    expect(findingCategories(extractReviewerFindings({ findings: many })).length).toBeLessThanOrEqual(CONCERN_CATEGORIES_MAX);
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
  it('truncates a category longer than the wire`s bound', () => {
    // The bound comes from the schema that owns it, not a literal. Written as `64` this passed
    // while a tightened schema bound silently put the producer back over the limit.
    const long = 'x'.repeat(200);
    const out = extractReviewerFindings({
      findings: [{ weight: 'high', category: long, claim: 'c', evidence: 'e' }],
    });
    expect(out[0]!.category).toHaveLength(CONCERN_CATEGORY_MAX_LEN);
  });

  it('caps the findings list at the wire`s concernCount bound', () => {
    // A reviewer emitting 400 findings used to take the whole event down with it. The cap comes
    // from the schema that owns it.
    const many = Array.from({ length: 400 }, (_, i) => ({
      weight: 'low' as const, category: 'style', claim: `c${i}`, evidence: 'e',
    }));
    expect(extractReviewerFindings({ findings: many })).toHaveLength(CONCERN_COUNT_MAX);
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

/**
 * The claim "the extractor cannot produce a record the wire will reject", asserted by ROUND TRIP.
 *
 * The block above states that invariant and then checks it against restated numbers — 64, 150, 16
 * written into the test. That is a third copy of a bound already owned by `wire-schema.ts` and
 * respected by `reviewer-findings.ts`, and the failure it guards against is severe: exceeding a
 * wire bound does not drop a FIELD, it fails schema parse, and the uploader drops the entire
 * event. Tighten a bound in the schema and the literal assertions here keep passing while the
 * producer emits records that vanish.
 *
 * These cases feed the extractor deliberately hostile reviewer output and hand the result to the
 * REAL schema. There is no number to keep in sync.
 */
describe('extractor output survives the actual wire schema', () => {
  /** A minimal valid review stage, varying only the field under test. */
  const stage = (categories: string[]) =>
    ReviewStageEntrySchema.parse({
      name: 'review',
      round: 0,
      model: 'claude-sonnet-4-6',
      tier: 'complex',
      durationMs: 1000,
      costUSD: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: null,
      cachedNonReadTokens: null,
      filesWrittenCount: 0,
      turnCount: 1,
      mainCostUSD: null,
      verdict: 'concerns',
      concernCategories: categories,
    });

  it('a reviewer category far over the bound still parses after extraction', () => {
    const findings = extractReviewerFindings({
      findings: [{ weight: 'high', category: 'x'.repeat(500), claim: 'c', evidence: 'e' }],
    });
    expect(() => stage(findingCategories(findings))).not.toThrow();
  });

  it('a reviewer emitting far too many distinct categories still parses', () => {
    const findings = extractReviewerFindings({
      findings: Array.from({ length: 400 }, (_, i) => ({
        weight: 'low', category: `category-${i}`, claim: 'c', evidence: 'e',
      })),
    });
    expect(() => stage(findingCategories(findings))).not.toThrow();
  });

  it('the producer clamps to the schema bounds rather than to its own copy of them', () => {
    // Ties the two together directly: whatever the schema permits is what the producer emits.
    const findings = extractReviewerFindings({
      findings: Array.from({ length: 400 }, (_, i) => ({
        weight: 'low', category: `${'y'.repeat(200)}-${i}`, claim: 'c', evidence: 'e',
      })),
    });
    expect(findings.length).toBeLessThanOrEqual(CONCERN_COUNT_MAX);
    const categories = findingCategories(findings);
    expect(categories.length).toBeLessThanOrEqual(CONCERN_CATEGORIES_MAX);
    for (const c of categories) expect(c.length).toBeLessThanOrEqual(CONCERN_CATEGORY_MAX_LEN);
  });
});
