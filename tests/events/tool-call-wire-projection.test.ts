import type { TurnResult } from '../../packages/core/src/types/run-result.js';
import { buildEnvelopeSnapshot } from '../../packages/server/src/application/telemetry-snapshot.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';

// The explicit `: TurnResult` return type is deliberate. buildEnvelopeSnapshot
// reads implTurn.usage.inputTokens unguarded (telemetry-snapshot.ts:38-55), so a
// structurally incomplete fixture throws at runtime. Typing the helper makes
// `npm run build` catch any future TurnResult field addition instead.
// NOTE: the turn-count field is `turns` (run-result.ts:17), never `numTurns`.
const turnOf = (
  toolCalls: { turn: number; tool: string }[],
  usedShell = false,
  filesWritten: string[] = [],
): TurnResult => ({
  output: '',
  usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  costUSD: 0,
  turns: 2,
  durationMs: 1,
  terminationReason: 'ok',
  filesWritten,
  usedShell,
  toolCalls,
});

const toWire = (turn: unknown) => {
  const envelope = buildEnvelopeSnapshot('t1', 'investigate', { status: 'done', implementerTurn: turn, reviewerTurn: null } as never, 'complex', 'standard', 'none', 'claude-haiku-4-5', 'claude-haiku-4-5', 'gpt-5.6', 'codex-cli', '/repo', 1);
  return toWireRecord(envelope, { toolMode: 'readonly', implementerModel: 'claude-haiku-4-5', implementerTier: 'complex', mainModelFamily: 'openai' });
};

it('groups CLAUDE-shaped tool calls onto the completed wire event', () => {
  const wire = toWire(turnOf([{ turn: 1, tool: 'Read' }, { turn: 1, tool: 'Read' }, { turn: 2, tool: 'Edit' }]));
  expect(wire.toolCalls).toEqual([{ stage: 'implementing', turn: 1, tool: 'Read', count: 2 }, { stage: 'implementing', turn: 2, tool: 'Edit', count: 1 }]);
});

/**
 * The privacy invariant, tested against a path that is actually present.
 *
 * This assertion used to read `expect(JSON.stringify(wire)).not.toContain('/secret/x.ts')` on a
 * fixture whose `filesWritten` was `[]` — the string appeared nowhere in the input, so nothing
 * could have made it appear in the output. It could not fail, under the name "without leaking
 * paths". Deleting the projection's `filesWritten` drop left it green.
 *
 * The paths that reach the envelope are the turn's own `filesWritten` (which
 * `buildEnvelopeSnapshot` also uses for `realFilesChanged` when there is no git answer) and the
 * cwd. `to-wire-record` must turn the first into a COUNT and never carry the second.
 */
it('carries only a count of the files written, never a path or the cwd', () => {
  const wire = toWire(turnOf([{ turn: 1, tool: 'Edit' }], false, ['/secret/x.ts', '/secret/y.ts']));
  const serialized = JSON.stringify(wire);

  expect(serialized).not.toContain('/secret/x.ts');
  expect(serialized).not.toContain('/secret');
  expect(serialized).not.toContain('/repo'); // the cwd passed to buildEnvelopeSnapshot
  // …and the fact the count is meant to convey survives the redaction.
  expect(wire.filesWrittenCount).toBe(2);
});

it('groups CODEX-shaped tool calls onto the completed wire event', () => {
  const wire = toWire(turnOf([{ turn: 1, tool: 'command_execution' }, { turn: 2, tool: 'file_change' }], true));
  expect(wire.toolCalls).toEqual([{ stage: 'implementing', turn: 1, tool: 'command_execution', count: 1 }, { stage: 'implementing', turn: 2, tool: 'file_change', count: 1 }]);
});