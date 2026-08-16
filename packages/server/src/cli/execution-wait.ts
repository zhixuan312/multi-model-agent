/**
 * execution-wait.ts — `mma execution wait <executionId>` subcommand.
 *
 * Blocks until an execution reaches a terminal state, then exits with a status code. This exists
 * for one reason: an agent that only executes in bursts cannot poll.
 *
 * `mma_execution_wait` over MCP is hard-capped at 55s by the client's request deadline, so any task
 * longer than a minute structurally requires a polling LOOP, and a loop requires a caller that is
 * still running. Agents are not: when a turn ends, execution stops completely, and nothing wakes
 * them for an mma task — the daemon owns it, so the client's own task tracking has no handle on it
 * and can send no notification.
 *
 * A blocking CLI command converts that untracked wait into a tracked one. An agent harness that can
 * run a background command gets a process it DOES own, whose exit it notices, and completion
 * re-enters the session with no hand-rolled polling at all:
 *
 *   mma execution wait <id> --timeout 3600   # in a tracked background job
 *
 * Two failure modes this deliberately avoids, both from a real incident:
 *
 *   - A hand-rolled `curl … | parse .status` loop with no auth header polled HTTP 401 for two hours
 *     and reported a false timeout while both tasks had long since completed. `curl -s` without
 *     `-f`, piped straight into a parser, turns every error body into "no status field" — which
 *     reads as "still running". Here, any non-2xx response EXITS with a distinct code and prints
 *     the body. It never loops on an error.
 *   - `GET /health` answers 200 unauthenticated while `GET /execution/:id` requires a token, so a
 *     health probe gives false confidence that unauthenticated access works. This command reads the
 *     token itself, so a caller never has to know that.
 *
 * Usage:
 *   mma execution wait <executionId> [--timeout <seconds>] [--interval <seconds>] [--json]
 *
 * Exit codes:
 *   0 — terminal and successful (`completed` / `done_with_concerns`)
 *   1 — terminal and unsuccessful (`failed` / `cancelled` / `interrupted`)
 *   2 — usage error (no executionId)
 *   3 — the wait timed out; the execution is STILL RUNNING and nothing was cancelled
 *   4 — could not reach or authenticate against the daemon, or the id is unknown
 */
import { readFileSync } from 'node:fs';

/**
 * Terminality comes from the HTTP STATUS, not from a list of state names.
 *
 * `GET /execution/:id` answers **202** with a running snapshot while work is in flight and **200**
 * with the terminal envelope once it is not. That is the engine's own signal and it cannot drift.
 *
 * The first version of this command enumerated terminal state names instead — and got it wrong on
 * the very first live execution, which reported `done`, a value not in the list. It waited out the
 * full timeout on an execution that had already finished. Enumerating a downstream copy of an
 * engine vocabulary is the mistake; the repo has hit it before.
 */
const RUNNING_HTTP = 202;

/**
 * Only these terminal states exit non-zero. Deliberately a FAILURE allowlist rather than a success
 * one: a state added later defaults to exit 0 instead of being reported as a failure that never
 * happened.
 */
const FAILURE_STATES = new Set(['failed', 'cancelled', 'interrupted']);

export interface ExecutionWaitDeps {
  serverUrl: string;
  tokenFile: string;
  executionId: string;
  /** Overall wait budget in seconds. Default 3600 — this is the whole point of the command. */
  timeoutSec?: number;
  /** Poll interval in seconds. Default 5. */
  intervalSec?: number;
  json?: boolean;
  stdout?: (s: string) => boolean;
  stderr?: (s: string) => boolean;
  fetchFn?: typeof fetch;
  /** Injected sleep so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock so a timeout is testable without elapsing one. */
  now?: () => number;
}

export async function runExecutionWait(deps: ExecutionWaitDeps): Promise<number> {
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const doFetch = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  if (!deps.executionId) {
    err('mma execution wait: an executionId is required\n');
    return 2;
  }

  let token: string;
  try {
    token = readFileSync(deps.tokenFile, 'utf8').trim();
  } catch {
    err(`mma execution wait: cannot read the auth token at ${deps.tokenFile}\n`
      + '  the daemon writes it on first start — try `mma status` first\n');
    return 4;
  }

  const timeoutMs = (deps.timeoutSec ?? 3600) * 1000;
  const intervalMs = (deps.intervalSec ?? 5) * 1000;
  const deadline = now() + timeoutMs;
  const url = `${deps.serverUrl}/execution/${encodeURIComponent(deps.executionId)}`;

  for (;;) {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-MMA-Client': 'other',
        },
      });
    } catch (e) {
      // Unreachable daemon is an ERROR, not "still running". Looping here is what turns a stopped
      // daemon into a silent multi-hour wait.
      err(`mma execution wait: cannot reach ${deps.serverUrl} — ${(e as Error).message}\n`);
      return 4;
    }

    if (!res.ok) {
      // Every non-2xx exits. A 401 that keeps looping is the incident this command exists to make
      // impossible: the body has no `status` field, which a naive parser reads as "not terminal".
      const body = await res.text().catch(() => '');
      err(`mma execution wait: HTTP ${res.status} from ${url}\n${body.slice(0, 400)}\n`);
      return 4;
    }

    const payload = (await res.json().catch(() => null)) as
      | { execution?: { status?: string }; status?: string }
      | null;
    const status = payload?.execution?.status ?? payload?.status;

    if (res.status !== RUNNING_HTTP) {
      // 200 = terminal envelope. Whatever the state is called, the work is over.
      if (deps.json) out(JSON.stringify(payload) + '\n');
      else out(`${deps.executionId} ${status ?? 'terminal'}\n`);
      return typeof status === 'string' && FAILURE_STATES.has(status) ? 1 : 0;
    }

    if (now() >= deadline) {
      // A timeout is NOT a failure of the execution, and nothing has been cancelled. Say so, so a
      // caller does not re-dispatch work that is still running.
      err(`mma execution wait: still ${status ?? 'running'} after ${deps.timeoutSec ?? 3600}s.\n`
        + '  The execution is UNAFFECTED and still running; nothing was cancelled.\n'
        + `  Wait again, or read it later with \`mma execution wait ${deps.executionId}\`.\n`);
      return 3;
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}
