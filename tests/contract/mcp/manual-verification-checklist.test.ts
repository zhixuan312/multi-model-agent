import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

/**
 * The manual Claude Desktop gate is the one AC no automated test can discharge — it needs a
 * host we neither ship nor can drive. What CAN be enforced is that the runbook recording it
 * still exists and still asks for all six observations, so the gate cannot quietly erode into
 * a document nobody can act on.
 */
describe('contract: manual Claude Desktop verification checklist (AC-7.2 artifact)', () => {
  it('records all six numbered steps with an Observe line and a Pass/Fail placeholder each', async () => {
    const doc = await readFile('docs/mcp-apps-desktop-manual-verification.md', 'utf8');
    for (let step = 1; step <= 6; step++) {
      expect(doc, `step ${step} must be present`).toMatch(new RegExp(`^${step}\\. `, 'm'));
    }
    expect((doc.match(/Observe:/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((doc.match(/Pass \/ Fail:/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(doc).toMatch(/mma mcp install/);
    expect(doc).toMatch(/byte-identical|unchanged.*text block|identical.*JSON/i);
  });
});
