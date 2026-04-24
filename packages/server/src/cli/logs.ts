/**
 * logs.ts — `mmagent logs` subcommand.
 *
 * Tails the diagnostic log file for today (mmagent-YYYY-MM-DD.jsonl). Supports
 * --follow for tail-F semantics and --batch=<id> to filter to a single batch.
 *
 * Exit codes:
 *   0 — success (including "no log file found" cases so scripts don't break)
 *   1 — reserved for future use
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

export interface LogsDeps {
  config: MultiModelConfig;
  homeDir?: string;
  follow?: boolean;
  batchId?: string;
  /** Polling interval when --follow; defaults to 300ms. */
  pollMs?: number;
  /** Max time to wait for the log file to appear under --follow; defaults to 30s. */
  waitForLogMs?: number;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveLogPath(config: MultiModelConfig, homeDir: string): string {
  const dir = config.diagnostics?.logDir ?? path.join(homeDir, '.multi-model', 'logs');
  return path.join(dir, `mmagent-${todayUtc()}.jsonl`);
}

function matchesBatch(line: string, batchId: string): boolean {
  return line.includes(`"batchId":"${batchId}"`);
}

export async function runLogs(deps: LogsDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const homeDir = deps.homeDir ?? os.homedir();
  const follow = deps.follow ?? false;
  const pollMs = deps.pollMs ?? 300;
  const waitForLogMs = deps.waitForLogMs ?? 30_000;

  if (!deps.config.diagnostics?.log) {
    stderr(`mmagent logs: diagnostics.log is false in config; set it to true to capture new events.\n`);
  }

  const logPath = resolveLogPath(deps.config, homeDir);

  if (!fs.existsSync(logPath)) {
    if (!follow) {
      stderr(`mmagent logs: no log file at ${logPath}. Start the server with diagnostics.log: true and try again.\n`);
      return 0;
    }
    const deadline = Date.now() + waitForLogMs;
    while (!fs.existsSync(logPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (!fs.existsSync(logPath)) {
      stderr(`mmagent logs: no log file appeared within ${Math.floor(waitForLogMs / 1000)}s at ${logPath}.\n`);
      return 0;
    }
  }

  // Emit existing content (optionally batch-filtered).
  let offset = 0;
  try {
    const existing = fs.readFileSync(logPath, 'utf8');
    for (const line of existing.split('\n')) {
      if (line.length === 0) continue;
      if (deps.batchId && !matchesBatch(line, deps.batchId)) continue;
      stdout(line + '\n');
    }
    offset = existing.length;
  } catch (err) {
    stderr(`mmagent logs: cannot read ${logPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 0;
  }

  if (!follow) return 0;

  // Tail — poll for new content appended after `offset`.
  let buf = '';
  while (true) {
    await new Promise((r) => setTimeout(r, pollMs));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(logPath);
    } catch {
      continue;
    }
    if (stat.size <= offset) continue;
    const fd = fs.openSync(logPath, 'r');
    try {
      const chunk = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      buf += chunk.toString('utf8');
      offset = stat.size;
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.split('\n');
    buf = lines.pop() ?? ''; // keep any trailing partial line for the next iteration
    for (const line of lines) {
      if (line.length === 0) continue;
      if (deps.batchId && !matchesBatch(line, deps.batchId)) continue;
      stdout(line + '\n');
    }
  }
}
