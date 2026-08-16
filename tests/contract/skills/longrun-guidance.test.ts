/**
 * A caller must be told that its polling is turn-bound, and that nothing will wake it.
 *
 * `mma_run` returns a handle; every skill then says to poll with `mma_execution_wait`; and the
 * tool's own description said "To wait longer, call again with the same executionId." Nothing
 * anywhere said that "call again" only happens while the caller's turn is alive, or that the client
 * is never notified when an mma execution finishes — the execution belongs to the daemon, not to
 * the client's task tracking.
 *
 * The consequence, reported from a real session: a dispatch was made, the turn ended, polling
 * stopped, and seven hours passed with the caller believing it was monitoring something. It was not
 * blocked — it simply was not executing.
 *
 * This is a GUIDANCE defect, not a correctness one, and the distinction is worth keeping straight:
 * the execution keeps running in the daemon and its terminal envelope is persisted to
 * `executions.db`, so `mma_execution_get` returns it later even across a restart. Nothing is lost.
 * That is exactly why it went unreported for so long — the symptom is a caller that looks stalled,
 * not a task that failed.
 *
 * Pinned in both places a caller actually reads: the shared include every packaged skill carries,
 * and the tool description an MCP client sees without opening any skill.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const INCLUDE = 'packages/server/src/skills/_shared/response-shape.md';
const SURFACE = 'packages/server/src/mcp/tool-surface.ts';

describe('callers are told a long dispatch outlasts their turn', () => {
  const include = readFileSync(INCLUDE, 'utf8');

  it('the shared include is the one every skill carries', () => {
    // Floor: if this file stops being the response-shape include, the assertions below are about
    // a document nobody reads.
    expect(include.length).toBeGreaterThan(500);
    expect(include).toContain('mma_execution_wait');
  });

  it('states that polling stops when the turn does', () => {
    expect(include, 'the include no longer warns that "call again" is turn-bound')
      .toMatch(/only happens while your turn is active/i);
  });

  it('states that no notification will arrive', () => {
    expect(include, 'a caller that expects to be woken will wait forever')
      .toMatch(/never told|not notified|no notification/i);
  });

  it('says what to do instead — hand the wait to something the client tracks', () => {
    expect(include).toMatch(/background job/i);
  });

  it('says plainly that nothing is lost, so a caller does not re-dispatch', () => {
    // The dangerous misreading is "my task died" → re-run a 40-minute execute_plan. The persisted
    // envelope is the reason that is never necessary.
    expect(include).toMatch(/nothing is lost/i);
    expect(include).toMatch(/persisted|store/i);
  });
});

describe('the wait tool says it too, for clients that read no skill', () => {
  const surface = readFileSync(SURFACE, 'utf8');

  it('finds the wait tool', () => {
    expect(surface).toContain("name: 'mma_execution_wait'");
  });

  it('the description does not stop at "call again"', () => {
    // "To wait longer, call again with the same executionId" alone is the instruction that produced
    // the dead air: correct, and silent about the one thing the caller needed to know.
    const at = surface.indexOf("name: 'mma_execution_wait'");
    const block = surface.slice(at, surface.indexOf('inputSchema', at));
    expect(block, 'the wait description is back to "call again" with no turn-boundary warning')
      .toMatch(/only happens while your turn is active/i);
    expect(block).toMatch(/NOT notified|not notified/i);
  });
});
