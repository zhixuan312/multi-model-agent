import type { Finding } from '@zhixuan92/multi-model-agent-core/events/task-envelope';

/**
 * Lift the reviewer's findings off `PipelineResult.reviewerOutput` so telemetry
 * can report them.
 *
 * Why this exists: `buildEnvelopeSnapshot` hardcoded `findings: []`, so
 * `concernCount` and `findingsBySeverity` on the wire were zero for every task
 * from 4.8.0 onward. A dashboard cannot tell "the reviewer found nothing" from
 * "nobody measured" when both arrive as 0 — the reading that a zero invites is
 * the dangerous one, because it says the code is clean.
 *
 * Six refiner schemas in `core/src/unified/refiner-schemas.ts` (audit,
 * investigate, review, debug, research, journal_recall) already carry
 * `findings: [{ weight, category, claim, evidence, ... }]`. This reads that
 * array. Note the field is `weight` on the refiner side and `severity` on the
 * envelope side — the rename is the whole reason a naive `as Finding[]` would
 * have produced findings with `severity: undefined` and silently bucketed every
 * one of them nowhere.
 *
 * Deliberately defensive rather than schema-parsed: `reviewerOutput` is typed
 * `unknown` and IS sometimes malformed (the pipeline downgrades an unparseable
 * reviewer to `done_with_concerns` and keeps going). Telemetry must never be
 * the thing that throws on a task that otherwise succeeded, so anything that
 * does not look like a finding is skipped instead of rejected.
 */
export function extractReviewerFindings(reviewerOutput: unknown): Finding[] {
  if (reviewerOutput === null || typeof reviewerOutput !== 'object') return [];
  const raw = (reviewerOutput as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];

  const findings: Finding[] = [];
  for (const [i, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object') continue;
    const f = entry as Record<string, unknown>;
    const severity = f.weight ?? f.severity;
    if (severity !== 'critical' && severity !== 'high' && severity !== 'medium' && severity !== 'low') {
      continue;
    }
    findings.push({
      // Positional, because the refiner schemas carry no id. Unique within a
      // task, which is the only scope anything reads it in.
      id: `f${i + 1}`,
      severity,
      category: typeof f.category === 'string' && f.category.trim() !== '' ? f.category.trim() : 'other',
      claim: typeof f.claim === 'string' ? f.claim : '',
      evidence: typeof f.evidence === 'string' ? f.evidence : '',
      ...(typeof f.suggestion === 'string' && f.suggestion !== '' ? { suggestion: f.suggestion } : {}),
      source: 'reviewer',
    });
  }
  return findings;
}

/**
 * The distinct categories the reviewer raised, in first-seen order.
 *
 * Free text on purpose. These used to be validated against a closed 14-value
 * `ConcernCategory` enum, which meant a reviewer writing `flaky_test` had it
 * flattened to `other` — the category signal was thrown away at exactly the
 * point it got interesting. The wire carries the reviewer's own word now and
 * the dashboard groups on it; see the `agentType: 'main'` incident for what
 * happens when a downstream store constrains an engine vocabulary.
 */
export function findingCategories(findings: Finding[]): string[] {
  return [...new Set(findings.map((f) => f.category))].slice(0, 16);
}

/**
 * Did this task look for problems, and did it find any?
 *
 * `clean` and `not_applicable` are the distinction that matters: a delegate run
 * reporting zero findings has not been reviewed for quality at all, while an
 * audit reporting zero has been and came back clean. Collapsing both to 0 is
 * what made the old dashboard's Findings column unreadable.
 */
export function deriveFindingsOutcome(
  findings: Finding[],
  reviewerRan: boolean,
  routeReportsFindings: boolean,
): 'found' | 'clean' | 'not_applicable' {
  if (!routeReportsFindings || !reviewerRan) return 'not_applicable';
  return findings.length > 0 ? 'found' : 'clean';
}

/**
 * The task types whose refiner schema has a `findings` array — i.e. the ones
 * where "zero findings" is a measurement rather than an absence of one.
 *
 * Keyed by unified TaskType (underscores), matching `REFINER_SCHEMAS`.
 */
export const FINDINGS_ROUTES: ReadonlySet<string> = new Set([
  'audit',
  'investigate',
  'review',
  'debug',
  'research',
  'journal_recall',
]);
