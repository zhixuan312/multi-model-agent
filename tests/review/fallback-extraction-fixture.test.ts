// End-to-end regression coverage for the read-only-tool findings pipeline,
// using REAL captured implementer output from production audits. These
// fixtures lock the contract between:
//   - the implementer prompts (audit/debug/review/verify executors)
//   - the deterministic extractor (`fallbackExtractFindings`)
//   - the lifecycle's `concerns` funnel
//   - the event-builder's `findingsBySeverity` rollup
//
// History: 3.12.5→3.12.7 was a five-release fix loop because each release
// fixed one regex / prompt mismatch but didn't catch the next one until
// the user re-ran the audit and reported it. These fixtures break that
// loop — every future change to either the prompts or the extractor MUST
// preserve the documented behavior on these captured outputs.
//
// When you change the implementer prompt: capture a fresh audit narrative,
// add it as a new fixture, and add an assertion below. Don't replace the
// existing ones — they prove backward compatibility with old narrative
// shapes still living in production telemetry.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fallbackExtractFindings } from '../../packages/core/src/review/fallback-extraction.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

describe('fallbackExtractFindings — captured implementer fixtures', () => {
  it('bullet-prefixed format (3.12.6+ standardized prompt) recovers severities exactly as written', () => {
    // Source: `goal.md` audit dispatched against a 3.12.6 daemon.
    // Implementer used `## Finding N: <title>` headings + `- Severity: X`
    // bulleted body lines. Exact severity counts grep'd from the fixture:
    //   $ grep -E "^- Severity:" captured-audit-narrative-bullets.md | sort | uniq -c
    //     2 - Severity: high
    //     5 - Severity: medium
    //     4 - Severity: low
    // Pre-3.12.7 SEVERITY_RE didn't accept the bullet prefix and defaulted
    // every finding to medium → telemetry showed "11 medium, 0 anything else"
    // even though the implementer wrote real severities.
    const text = loadFixture('captured-audit-narrative-bullets.md');
    const findings = fallbackExtractFindings(text);

    expect(findings).toHaveLength(11);

    const bySev = findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    expect(bySev).toEqual({ high: 2, medium: 5, low: 4 });

    // Claim derivation: section heading carried a real title, so claim
    // comes from there (not from the body's Issue: label). First claim
    // should be a real one-liner, not a generic "Finding N".
    expect(findings[0]!.claim).not.toBe('Finding 1');
    expect(findings[0]!.claim.length).toBeGreaterThan(20);
    expect(findings[0]!.claim).not.toMatch(/^Severity:/i);
    // Every finding must be evidence-grounded (its evidence is a verbatim
    // substring of the source text). Pre-3.12.6 the trailing-whitespace bug
    // caused titles to be "Severity: critical" — clearly not from the source.
    for (const f of findings) {
      expect(f.evidenceGrounded).toBe(true);
      expect(f.id).toMatch(/^F\d+$/);
      expect(f.reviewerConfidence).toBeNull();
    }
  });

  it('legacy bold-numbered format (`**1.**` headers, pre-3.12.6 prompt) still extracts findings', () => {
    // Source: `goal.md` audit dispatched against a 3.12.5 daemon, which used
    // the OLD prompt and produced bold-numbered headings (`**1.**` on its own
    // line) followed by bare label lines (`Severity: critical`). This format
    // is preserved in production telemetry; backward compatibility matters.
    const text = loadFixture('captured-audit-narrative-legacy-bold.md');
    const findings = fallbackExtractFindings(text);

    expect(findings.length).toBeGreaterThanOrEqual(25);

    const bySev = findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    // Sanity: at least some non-medium severities — proves SEVERITY_RE
    // matched the bare `Severity: critical` lines (no bullet prefix).
    const nonMediumCount = (bySev.critical ?? 0) + (bySev.high ?? 0) + (bySev.low ?? 0);
    expect(nonMediumCount).toBeGreaterThan(0);
    // Specifically: at least one critical and several high.
    expect(bySev.critical ?? 0).toBeGreaterThan(0);
    expect(bySev.high ?? 0).toBeGreaterThan(0);

    // Claims should not be the synthetic catch-all (claim starting with
    // "reviewer parse failed" is the no-sections fallback fingerprint).
    expect(findings[0]!.claim).not.toMatch(/^reviewer parse failed/);
  });

  it('no-findings narrative (worker says "no findings detected") emits empty array, not catch-all', () => {
    // Round-2 #6 contract: an explicit "no findings" narrative must NOT
    // generate a synthetic catch-all. Some workers correctly report that
    // they found nothing — the dashboard should reflect that.
    const text = '# Audit Report\n\nNo findings detected. All checks passed cleanly.';
    const findings = fallbackExtractFindings(text);
    expect(findings).toEqual([]);
  });

  it('catch-all only fires for narratives without parseable structure AND without "no findings" language', () => {
    // Defensive contract: when the worker dumps prose with no numbered
    // sections AND no explicit "no findings" language, a single synthetic
    // catch-all is emitted so downstream telemetry has at least one entry.
    // The transport-failure salvage path in `runAnnotationReview` filters
    // this catch-all out via `realFindingsFromWorker` (so transport
    // failures don't fabricate findings) — but `fallbackExtractFindings`
    // itself still emits it for the parse-failure path that has a real
    // (just unparseable) reviewer response.
    const text = 'Some prose explaining things, but no structured numbered findings here at all.';
    const findings = fallbackExtractFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.claim).toMatch(/^reviewer parse failed/);
    expect(findings[0]!.severity).toBe('medium');
  });
});
