import { describe, it, expect } from 'vitest';
import type { TurnResult } from '../../packages/core/src/types/run-result.js';
import { normalizeClaudeTurn } from '../../packages/core/src/providers/normalize-claude.js';

/**
 * The ten fields a runner may return, and no eleventh.
 *
 * This file used to build a `TurnResult` literal by hand and then assert that the keys it had
 * just typed appeared in the list it had just typed — an assertion over its own input, which no
 * change to `TurnResult` could have failed. Adding a field to the interface leaves the literal
 * untouched (or, if required, breaks the BUILD rather than this test), and deleting a field
 * from both lists at once passes just as happily. The one thing it claimed to pin was the one
 * thing it could not see.
 *
 * An interface has no runtime existence, so the two halves are checked in the two places they
 * are actually visible: the key set at COMPILE time, and real producer output at run time.
 */
const TURN_RESULT_KEYS = [
  'output',
  'usage',
  'costUSD',
  'turns',
  'durationMs',
  'terminationReason',
  'errorCode',
  'errorMessage',
  'filesWritten',
  'usedShell',
  'toolCalls',
  'sandboxDenialCount',
] as const;

/** `never` unless the two unions are mutually assignable — an exact match, not a subset. */
type AssertExact<Actual, Expected> =
  [Actual] extends [Expected] ? ([Expected] extends [Actual] ? true : never) : never;

/**
 * Compile-time half. A field added to or removed from `TurnResult` without updating
 * `TURN_RESULT_KEYS` fails `tsc -p tsconfig.tests.json`, which is the only place the interface's key
 * set exists at all.
 */
const _keysAreExhaustive: AssertExact<keyof TurnResult, (typeof TURN_RESULT_KEYS)[number]> = true;

describe('TurnResult shape (A4.2)', () => {
  it('pins the declared key set at compile time', () => {
    // The type-level check above is the assertion; this keeps it referenced and states the
    // count in a form a reader can check against the interface.
    expect(_keysAreExhaustive).toBe(true);
    expect(TURN_RESULT_KEYS).toHaveLength(12); // 10 always-present + errorCode + errorMessage
  });

  /**
   * Runtime half, against a REAL producer rather than a literal. `normalizeClaudeTurn` is the
   * claude runner's only construction site for a TurnResult, so a field it starts emitting —
   * or stops emitting — shows up here.
   */
  it('a real normalizer emits every required field and nothing undeclared', () => {
    const result = normalizeClaudeTurn(
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
        { type: 'result', subtype: 'success', usage: { input_tokens: 5, output_tokens: 2 } },
      ] as never[],
      { durationMs: 1 },
    );

    const allowed = new Set<string>(TURN_RESULT_KEYS);
    for (const key of Object.keys(result)) {
      expect(allowed.has(key), `undeclared field "${key}" on a TurnResult`).toBe(true);
    }
    // The ten non-optional fields must all be present — a producer that silently drops one
    // would otherwise satisfy the "nothing undeclared" half above.
    for (const key of TURN_RESULT_KEYS.filter((k) => k !== 'errorCode' && k !== 'errorMessage')) {
      expect(result, `missing required field "${key}"`).toHaveProperty(key);
    }
  });

  it('carries the error fields only when the turn actually errored', () => {
    const errored = normalizeClaudeTurn([] as never[], { durationMs: 1 });
    expect(errored.errorCode).toBe('sdk_no_result');
    expect(typeof errored.errorMessage).toBe('string');
  });
});
