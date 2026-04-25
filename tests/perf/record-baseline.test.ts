import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
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
const SKIP = existsSync(BASELINE_PATH) || process.env.MMAGENT_PERF_SUITE === '1';

describe.skipIf(SKIP)('perf baseline (one-shot capture)', () => {
  it('captures all five metrics and writes baseline.json', async () => {
    const runs = 5;
    const startups: number[] = [];
    const latencies: number[] = [];
    const rssPeaks: number[] = [];

    for (let i = 0; i < runs; i++) {
      startups.push(await captureStartup());
      latencies.push(await captureDelegateLatency());
      rssPeaks.push(await capturePeakRssFor10Tasks());
    }

    const contractRuns: number[] = [];
    const fullRuns: number[] = [];
    for (let i = 0; i < 3; i++) {
      contractRuns.push(captureSuiteWallClock('contract'));
      fullRuns.push(captureSuiteWallClock('full'));
    }

    const metrics: PerfMetrics = {
      delegateLatencyMs: medianOf(latencies),
      startupMs: medianOf(startups),
      peakRssBytes: medianOf(rssPeaks),
      contractSuiteMs: medianOf(contractRuns),
      fullSuiteMs: medianOf(fullRuns),
      capturedAt: new Date().toISOString(),
    };

    writeFileSync(BASELINE_PATH, JSON.stringify(metrics, null, 2));

    for (const [k, v] of Object.entries(metrics)) {
      if (k === 'capturedAt') continue;
      expect(v, `${k} must be positive`).toBeGreaterThan(0);
    }
  }, 300_000);
});
