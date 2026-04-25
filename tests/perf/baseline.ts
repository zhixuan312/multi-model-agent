import { spawnSync } from 'node:child_process';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

export interface PerfMetrics {
  contractSuiteMs: number;
  delegateLatencyMs: number;
  startupMs: number;
  peakRssBytes: number;
  fullSuiteMs: number;
  capturedAt: string;
}

export async function captureStartup(): Promise<number> {
  const t0 = performance.now();
  const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
  await h.close();
  return performance.now() - t0;
}

export async function captureDelegateLatency(): Promise<number> {
  const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
  try {
    const t0 = performance.now();
    const d = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ tasks: [{ prompt: 'p' }] }),
    });
    const { batchId } = (await d.json()) as { batchId: string };
    while (true) {
      const p = await fetch(`${h.baseUrl}/batch/${batchId}`, {
        headers: { Authorization: `Bearer ${h.token}` },
      });
      if (p.status === 200) break;
      await new Promise((r) => setImmediate(r));
    }
    return performance.now() - t0;
  } finally {
    await h.close();
  }
}

export async function capturePeakRssFor10Tasks(): Promise<number> {
  const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
  try {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ prompt: `perf-${i}` }));
    const d = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(process.cwd())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
      body: JSON.stringify({ tasks }),
    });
    const { batchId } = (await d.json()) as { batchId: string };
    let peak = process.memoryUsage().rss;
    const poll = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      while (true) {
        const p = await fetch(`${h.baseUrl}/batch/${batchId}`, {
          headers: { Authorization: `Bearer ${h.token}` },
        });
        if (p.status === 200) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      clearInterval(poll);
    }
    return peak;
  } finally {
    await h.close();
  }
}

export function captureSuiteWallClock(target: 'contract' | 'full'): number {
  const args = target === 'contract' ? ['vitest', 'run', 'tests/contract'] : ['vitest', 'run'];
  const t0 = performance.now();
  const res = spawnSync('npx', args, {
    stdio: 'ignore',
    env: { ...process.env, MMAGENT_PERF_SUITE: '1' },
  });
  if (res.status !== 0) throw new Error(`${target} suite failed during perf capture`);
  return performance.now() - t0;
}

export function medianOf(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
