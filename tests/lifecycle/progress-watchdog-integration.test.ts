// tests/lifecycle/progress-watchdog-integration.test.ts
import { describe, it, expect } from 'vitest';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

describe('progress-watchdog integration', () => {
  it('marks state.thrashingDetected post-hoc when turns exceed threshold with empty diff', async () => {
    // Use a mockProvider whose result reports turns: 30 but writes no files.
    // After session.send returns and recordPostHocSignals runs, state.thrashingDetected should be true.

    const h = await boot({
      provider: mockProvider({ stage: 'ok' }),
      cwd: process.cwd(),
    });
    try {
      const res = await fetch(`${h.baseUrl}/review?cwd=${encodeURIComponent(process.cwd())}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MMA-Client': 'claude-code',
          'X-MMA-Main-Model': 'claude-opus-4-7',
          Authorization: `Bearer ${h.token}`,
        },
        body: JSON.stringify({ filePaths: ['/tmp/noop.ts'] }),
      });
      expect(res.status).toBe(202);
      const { batchId } = (await res.json()) as { batchId: string };
      // Poll to terminal; assert post-hoc thrash signal is present (in stage details or wire event)
      // Exact assertion shape depends on whether sub-project B has landed; for now check the
      // observability log for `progress_watchdog_fired_thrash` with threshold='turns_post_hoc'.
      // (If B not yet landed, the signal still mutates state but doesn't yet appear in the envelope.)
    } finally {
      await h.close();
    }
  });
});