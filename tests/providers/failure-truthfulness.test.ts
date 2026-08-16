// A failure must never be reported as a success.
//
// Three defects found by live probing (EVAL-001/002/003 of the 2026-08-14 capability
// evaluation) shared one shape: an execution that did no work, or was killed, or could not
// reach its provider at all, arrived at the caller wearing a success status. Each test below
// reproduces the exact signal the real runner saw.

import { normalizeClaudeTurn } from '../../packages/core/src/providers/normalize-claude.js';
import { terminalTaskUpdate } from '../../packages/server/src/application/initiative-linker.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** The event stream the claude SDK really produced when the tier's endpoint refused the
 *  connection: an assistant message carrying the error text, then a result event whose
 *  subtype is `success` and whose usage counters are all zero. */
function connectionRefusedStream(): SDKMessage[] {
  const text = 'API Error: Unable to connect to API (ConnectionRefused)';
  return [
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    {
      type: 'result',
      subtype: 'success',
      result: text,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  ] as unknown as SDKMessage[];
}

/** A genuinely successful turn, for the contrast case: real tokens billed. */
function realWorkStream(): SDKMessage[] {
  return [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The answer is 4.' }] } },
    {
      type: 'result',
      subtype: 'success',
      result: 'The answer is 4.',
      usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  ] as unknown as SDKMessage[];
}

describe('EVAL-003 — a provider outage is not a successful turn', () => {
  it('does not report `ok` for a success result that billed zero tokens', () => {
    const turn = normalizeClaudeTurn(connectionRefusedStream(), { durationMs: 120 });
    expect(turn.terminationReason).toBe('error');
  });

  it('carries an error code naming the reason, not the provider error text', () => {
    const turn = normalizeClaudeTurn(connectionRefusedStream(), { durationMs: 120 });
    expect(turn.errorCode).toBe('sdk_no_work_billed');
    expect(turn.errorMessage).toBeTruthy();
  });

  it('still reports `ok` when the model actually did work', () => {
    const turn = normalizeClaudeTurn(realWorkStream(), { durationMs: 900 });
    expect(turn.terminationReason).toBe('ok');
    expect(turn.errorCode).toBeUndefined();
  });

  it('leaves an explicit caller guard authoritative', () => {
    // guardTerminationReason is how a cancelling caller overrides the stream's own verdict.
    const turn = normalizeClaudeTurn(connectionRefusedStream(), {
      durationMs: 120,
      guardTerminationReason: 'cancelled',
    });
    expect(turn.terminationReason).toBe('cancelled');
  });
});

describe('EVAL-002 — a failed Execution leaves its Task retryable', () => {
  it('moves a failed Execution\'s Task to blocked, per the frozen matrix', () => {
    expect(terminalTaskUpdate('failed')).toEqual({ transition: 'blocked', outcome: undefined });
  });

  it('admits a linked Execution from every status the matrix leaves resolvable', async () => {
    // The matrix's own contract: `blocked` leaves the Task "open for a human OR A RETRIED
    // EXECUTION to resolve". A retry is only possible if admission accepts that status.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../packages/server/src/application/execution-runtime.ts', import.meta.url), 'utf8'),
    );
    const guard = src.match(/if \(task\.status !== [^)]*\) \{/)?.[0] ?? '';
    expect(guard, 'admission guard must accept a blocked Task for retry').toContain("'blocked'");
  });
});

describe('EVAL-001 — a signal-killed worker is not a successful turn', () => {
  it('treats a signal death as an error even though exitCode is null', async () => {
    // A process killed by SIGKILL reports `exitCode: null, signalCode: 'SIGKILL'`. The
    // termination check must consider the signal, not exit code alone.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../packages/core/src/providers/codex-cli-session.ts', import.meta.url), 'utf8'),
    );
    expect(src, 'codex termination mapping must inspect signalCode').toMatch(/signalCode/);
  });
});
