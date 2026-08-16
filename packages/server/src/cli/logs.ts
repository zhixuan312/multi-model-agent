/**
 * logs.ts — `mma logs` subcommand.
 *
 * Tails the diagnostic log file for today (mma-YYYY-MM-DD.jsonl). Supports
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

interface LogsDeps {
  /**
   * Only `diagnostics` is read (the log directory and the enabled flag), so only `diagnostics` is
   * demanded. Asking for a whole `MultiModelConfig` made every caller that does not have one —
   * which is every test — assemble a fake config and cast it past the compiler three times over.
   */
  config: Pick<MultiModelConfig, 'diagnostics'>;
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

function resolveLogPath(config: Pick<MultiModelConfig, 'diagnostics'>, homeDir: string): string {
  const dir = config.diagnostics?.logDir ?? path.join(homeDir, '.mma', 'logs');
  return path.join(dir, `mma-${todayUtc()}.jsonl`);
}

/**
 * Where the tail should read from on the next poll.
 *
 * Two things can move the target out from under a `--follow` session, and both used to silence it
 * permanently (audit M3-3):
 *   - ROTATION. The writer switches to `mma-<date>.jsonl` at UTC midnight, so a session started
 *     the previous day kept tailing a file nothing writes to any more.
 *   - TRUNCATION. A file that shrank left `offset` past its end, and `size <= offset` then skipped
 *     every subsequent poll forever.
 *
 * Pure so the decision is testable without racing the endless poll loop.
 */
export function nextFollowTarget(
  current: { path: string; offset: number },
  resolvedPath: string,
  resolvedExists: boolean,
  size: number,
): { path: string; offset: number } {
  if (resolvedPath !== current.path && resolvedExists) return { path: resolvedPath, offset: 0 };
  if (size < current.offset) return { path: current.path, offset: 0 };
  return current;
}

function matchesBatch(line: string, batchId: string): boolean {
  // The JSONL log carries the task/batch id under several key spellings depending on
  // the writer: plain diagnostic entries nest it in `fields` as snake_case
  // (`task_id` / `batch_id`), envelope snapshots use `taskId`, and wire records use
  // `batchId`. Match ALL forms so `--batch=<id>` returns the complete trace for a task
  // rather than the single line that happens to use one spelling.
  return (
    line.includes(`"taskId":"${batchId}"`) ||
    line.includes(`"task_id":"${batchId}"`) ||
    line.includes(`"batchId":"${batchId}"`) ||
    line.includes(`"batch_id":"${batchId}"`)
  );
}

export async function runLogs(deps: LogsDeps): Promise<number> {
  const stdout = deps.stdout ?? process.stdout.write.bind(process.stdout);
  const stderr = deps.stderr ?? process.stderr.write.bind(process.stderr);
  const homeDir = deps.homeDir ?? os.homedir();
  const follow = deps.follow ?? false;
  const pollMs = deps.pollMs ?? 300;
  const waitForLogMs = deps.waitForLogMs ?? 30_000;

  if (!deps.config.diagnostics?.log) {
    stderr(`mma logs: diagnostics.log is false in config; set it to true to capture new events.\n`);
  }

  const logPath = resolveLogPath(deps.config, homeDir);

  if (!fs.existsSync(logPath)) {
    if (!follow) {
      stderr(`mma logs: no log file at ${logPath}. Start the server with diagnostics.log: true and try again.\n`);
      return 0;
    }
    const deadline = Date.now() + waitForLogMs;
    while (!fs.existsSync(logPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (!fs.existsSync(logPath)) {
      stderr(`mma logs: no log file appeared within ${Math.floor(waitForLogMs / 1000)}s at ${logPath}.\n`);
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
    stderr(`mma logs: cannot read ${logPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 0;
  }

  if (!follow) return 0;

  // Tail — poll for new content appended after `offset`.
  //
  // The path is RE-RESOLVED every poll rather than captured once. The writer rotates to
  // `mma-<date>.jsonl` at UTC midnight, so a session started before midnight kept tailing
  // yesterday's file and went silent for the rest of the run while the daemon wrote to today's —
  // indistinguishable, to the user, from "nothing is happening" (audit M3-3).
  let buf = '';
  let followPath = logPath;
  while (true) {
    await new Promise((r) => setTimeout(r, pollMs));
    const resolvedPath = resolveLogPath(deps.config, homeDir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fs.existsSync(resolvedPath) ? resolvedPath : followPath);
    } catch {
      continue;
    }
    const target = nextFollowTarget(
      { path: followPath, offset },
      resolvedPath,
      fs.existsSync(resolvedPath),
      stat.size,
    );
    if (target.path !== followPath || target.offset !== offset) {
      followPath = target.path;
      offset = target.offset;
      buf = '';
      try { stat = fs.statSync(followPath); } catch { continue; }
    }
    if (stat.size <= offset) continue;
    const fd = fs.openSync(followPath, 'r');
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
