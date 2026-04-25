import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  captureStartup,
  captureDelegateLatency,
  capturePeakRssFor10Tasks,
  captureSuiteWallClock,
  medianOf,
  type PerfMetrics,
} from './baseline.js';

const BASELINE_PATH = resolve('tests/perf/baseline.json');
// Budget assertions are a LANDING gate (per spec DoD criterion 5), not a
// per-commit check. Running them during normal `npm test` compares against
// a just-captured baseline in the same process, where resource contention
// causes spurious failures. Gate behind MMAGENT_PERF_CHECK=1 so CI / the
// release gate can run them explicitly; normal test runs skip.
const SKIP =
  !existsSync(BASELINE_PATH) ||
  process.env.MMAGENT_PERF_SUITE === '1' ||
  process.env.MMAGENT_PERF_CHECK !== '1';

describe.skipIf(SKIP)('perf budget', () => {
  const baseline = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as PerfMetrics)
    : null;

  it('delegate latency is within +5% of baseline', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push(await captureDelegateLatency());
    expect(baseline).not.toBeNull();
    expect(medianOf(samples)).toBeLessThanOrEqual(baseline!.delegateLatencyMs * 1.05);
  }, 120_000);

  it('startup is within +10% of baseline', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push(await captureStartup());
    expect(baseline).not.toBeNull();
    expect(medianOf(samples)).toBeLessThanOrEqual(baseline!.startupMs * 1.10);
  }, 120_000);

  it('peak RSS for 10-task batch is within +10% of baseline', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) samples.push(await capturePeakRssFor10Tasks());
    expect(baseline).not.toBeNull();
    expect(medianOf(samples)).toBeLessThanOrEqual(baseline!.peakRssBytes * 1.10);
  }, 120_000);

  it('contract-suite wall-clock is within +10% of baseline', () => {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) samples.push(captureSuiteWallClock('contract'));
    expect(baseline).not.toBeNull();
    expect(medianOf(samples)).toBeLessThanOrEqual(baseline!.contractSuiteMs * 1.10);
  }, 300_000);

  it('contract suite completes within the 60s CI cap', () => {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) samples.push(captureSuiteWallClock('contract'));
    expect(medianOf(samples)).toBeLessThanOrEqual(60_000);
  }, 300_000);

  it('full-suite wall-clock is within +15% of baseline', () => {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) samples.push(captureSuiteWallClock('full'));
    expect(baseline).not.toBeNull();
    expect(medianOf(samples)).toBeLessThanOrEqual(baseline!.fullSuiteMs * 1.15);
  }, 300_000);
});
