import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, type HarnessHandle } from './harness.js';
import { mockProvider, failProvider } from './mock-providers.js';
import type { EventType } from '../../../packages/core/src/observability/events.js';

async function bootAndCapture(
  provider: ReturnType<typeof mockProvider>,
  scenario: (handle: HarnessHandle, cwd: string, logDir: string) => Promise<void>,
): Promise<EventType[]> {
  const cwd = mkdtempSync(join(tmpdir(), 'mma-fixture-'));
  const logDir = mkdtempSync(join(tmpdir(), 'mma-logs-'));
  process.env.MMAGENT_LOG_DIR = logDir;
  const handle = await boot({ provider, cwd });
  try {
    await scenario(handle, cwd, logDir);
  } finally {
    await handle.close();
  }
  const files = readdirSync(logDir).filter((f: string) => f.endsWith('.jsonl'));
  const events: EventType[] = [];
  for (const f of files) {
    const content = readFileSync(join(logDir, f), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* malformed line — skip */ }
    }
  }
  return events;
}

async function pollToTerminal(baseUrl: string, token: string, batchId: string): Promise<void> {
  for (let i = 0; i < 180; i++) {
    const poll = await fetch(`${baseUrl}/batch/${batchId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (poll.status === 200) return;
    if (poll.status !== 202) throw new Error(`Unexpected status ${poll.status} polling batch ${batchId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`poll timeout ${batchId}`);
}

/** Aggregator. */
export async function runFullFixtureSuite(): Promise<EventType[]> {
  return [
    ...(await runTaskLifecycleFixtures()),
    ...(await runEdgeCaseFixtures()),
    ...(await runCloudFixtures()),
  ];
}

/** Two delegate tasks: exercises the delegate → batch lifecycle. */
export async function runTaskLifecycleFixtures(): Promise<EventType[]> {
  const provider = mockProvider({
    sequence: [
      { status: 'ok', output: 'task 0 done', filesWritten: ['a.ts'], workerStatus: 'done' },
      { status: 'ok', output: 'reviewed: approved', filesWritten: [], workerStatus: 'done' },
      { status: 'ok', output: 'task 1 done', filesWritten: ['b.ts'], workerStatus: 'done' },
      { status: 'ok', output: 'reviewed: changes_required\n[rework_required]', filesWritten: [], workerStatus: 'done' },
      { status: 'ok', output: 'task 1 reworked', filesWritten: ['b.ts'], workerStatus: 'done' },
      { status: 'ok', output: 'reviewed: approved', filesWritten: [], workerStatus: 'done' },
      { status: 'ok', output: 'quality: approved', filesWritten: [], workerStatus: 'done' },
    ],
  });
  return bootAndCapture(provider, async (h, cwd) => {
    const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${h.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ prompt: 'task 0', filePaths: ['a.ts'] }, { prompt: 'task 1', filePaths: ['b.ts'] }] }),
    });
    const { batchId } = (await dispatch.json()) as { batchId: string };
    await pollToTerminal(h.baseUrl, h.token, batchId);
  });
}

/** Edge cases: batch_failed via invalid request, api_error provider, stall_abort. */
export async function runEdgeCaseFixtures(): Promise<EventType[]> {
  const events: EventType[] = [];

  // Sub-fixture A: failProvider returning api_error — triggers batch_failed
  events.push(...await bootAndCapture(failProvider({ status: 'api_error', errorCode: 'api_error' }), async (h, cwd) => {
    const dispatch = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${h.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ prompt: 'will fail' }] }),
    });
    const { batchId } = (await dispatch.json()) as { batchId: string };
    await pollToTerminal(h.baseUrl, h.token, batchId);
  }));

  // Sub-fixture B: stall_abort — provider that hangs, triggering idle detection
  events.push(...await bootAndCapture(mockProvider({ delayMs: 10_000 }), async (h, cwd) => {
    await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${h.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ prompt: 'stall' }] }),
    });
    // Do not poll to terminal; the server will abort the stall on its own
    await new Promise((r) => setTimeout(r, 300));
  }));

  // Sub-fixture C: invalid request body — returns 400 (no batch created)
  events.push(...await bootAndCapture(mockProvider({}), async (h, cwd) => {
    const res = await fetch(`${h.baseUrl}/delegate?cwd=${encodeURIComponent(cwd)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${h.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: [{ /* missing prompt field */ }] }),
    });
    // Expect 400 — no batch emitted; fixture captures any events that happen
    await res.text();
  }));

  return events;
}

/** Cloud lifecycle: exercises server startup and introspection events.
 *
 * session.started fires automatically on boot (wired in a future task).
 * install.changed fires when install version is detected (wired in a future task).
 * skill.installed fires on install-skill (wired in a future task).
 * For now the fixture hits the health + status endpoints to exercise the capture
 * pipeline and will automatically pick up cloud events as they are wired. */
export async function runCloudFixtures(): Promise<EventType[]> {
  return bootAndCapture(mockProvider({}), async (h, cwd) => {
    await fetch(`${h.baseUrl}/health`, { headers: { 'Authorization': `Bearer ${h.token}` } });
    await fetch(`${h.baseUrl}/status`, { headers: { 'Authorization': `Bearer ${h.token}` } });
    await fetch(`${h.baseUrl}/tools`, { headers: { 'Authorization': `Bearer ${h.token}` } });
  });
}
