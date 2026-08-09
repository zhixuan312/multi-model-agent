import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The `client-attribution` check in the full-smoke harness must distinguish a DEFECT from an
 * UNSETTLED sample.
 *
 * The check proves caller attribution survives header → resolveCallerIdentity → wire event. It
 * samples the telemetry queue by line-count window, and a wire event carries `eventId`, `route`
 * and `client` but deliberately no task id, so the sample cannot separate the harness's own
 * events from another client's events written during the same window.
 *
 * Before this change the check failed on ANY foreign client. On 2026-08-09 that turned one
 * `journal_record` dispatched through the MCP plugin into five hard failures across a
 * 50-scenario release gate, reported as `client=[claude-code, agent-plugin] want=claude-code`.
 * A reader would reasonably start hunting an attribution bug that did not exist.
 *
 * The three outcomes are different facts and must stay separated:
 *   FAIL — the harness's own client never appears. Attribution really did break.
 *   WARN — the harness's client appears alongside a foreign one. Nothing was learned.
 *   PASS — only the harness's client is present.
 *
 * This is asserted against the harness SOURCE rather than by executing it, because the check
 * lives inside a 700-line function that needs a full scenario record to run. The source
 * assertions are specific enough to fail if the three-way logic is collapsed back into a
 * boolean, which is the regression that matters.
 */

const verifySource = () => readFileSync('scripts/full-smoke/verify.mjs', 'utf8');

describe('full-smoke client-attribution separates a defect from an unsettled sample', () => {
  it('fails only when the harness own client is absent', () => {
    const src = verifySource();
    // The FAIL branch must be gated on the harness's client being missing, never on the mere
    // presence of another client.
    expect(src).toContain("!mineSeen ? 'FAIL'");
    expect(src).toContain('const mineSeen = clients.includes(SMOKE_CLIENT)');
  });

  it('reports a foreign client as unsettled rather than as a failure', () => {
    const src = verifySource();
    expect(src).toContain("foreign.length > 0 ? 'WARN'");
    expect(src).toContain('const foreign = clients.filter((c) => c !== SMOKE_CLIENT)');
  });

  it('passes only when the harness own client is the sole client', () => {
    // With mineSeen true and foreign empty, the remaining branch is PASS. Asserting the ordering
    // keeps a future edit from letting a foreign client fall through to PASS.
    const src = verifySource();
    const failIdx = src.indexOf("!mineSeen ? 'FAIL'");
    const warnIdx = src.indexOf("foreign.length > 0 ? 'WARN'");
    const passIdx = src.indexOf("          : 'PASS'");
    expect(failIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(failIdx);
    expect(passIdx).toBeGreaterThan(warnIdx);
  });

  it('tells the operator what to do, not merely that something differed', () => {
    // The old message named the clients and stopped there. A gate failure a reader cannot act on
    // wastes exactly the time a gate is supposed to save.
    const src = verifySource();
    expect(src).toContain('needs exclusive use of the daemon');
    expect(src).toContain('UNSETTLED');
  });

  it('still treats an empty sample as not-applicable, never as a pass', () => {
    // A check that silently reports success when it collected nothing is indistinguishable from
    // a check that always passes.
    expect(verifySource()).toContain("clients.length === 0 ? 'NA'");
  });
});
