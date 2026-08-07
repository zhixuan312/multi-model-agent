import type { TurnResult } from '../../packages/core/src/types/run-result.js';
import { buildEnvelopeSnapshot } from '../../packages/server/src/application/telemetry-snapshot.js';
import { toWireRecord } from '../../packages/core/src/events/to-wire-record.js';

// The explicit `: TurnResult` return type is deliberate. buildEnvelopeSnapshot
// reads implTurn.usage.inputTokens unguarded (telemetry-snapshot.ts:38-55), so a
// structurally incomplete fixture throws at runtime. Typing the helper makes
// `npm run build` catch any future TurnResult field addition instead.
// NOTE: the turn-count field is `turns` (run-result.ts:17), never `numTurns`.
const turnOf = (toolCalls: { turn: number; tool: string }[], usedShell = false): TurnResult => ({
  output: '',
  usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedNonReadTokens: 0 },
  costUSD: 0,
  turns: 2,
  durationMs: 1,
  terminationReason: 'ok',
  filesWritten: [],
  usedShell,
  toolCalls,
});

const toWire = (turn: unknown) => {
  const envelope = buildEnvelopeSnapshot('t1', 'investigate', { status: 'done', implementerTurn: turn, reviewerTurn: null } as never, 'complex', 'standard', 'none', 'claude-haiku-4-5', 'claude-haiku-4-5', 'gpt-5.6', 'codex-cli', '/repo', 1);
  return toWireRecord(envelope, { toolMode: 'readonly', implementerModel: 'claude-haiku-4-5', implementerTier: 'complex', mainModelFamily: 'openai' });
};

it('groups CLAUDE-shaped tool calls onto the completed wire event without leaking paths', () => {
  const wire = toWire(turnOf([{ turn: 1, tool: 'Read' }, { turn: 1, tool: 'Read' }, { turn: 2, tool: 'Edit' }]));
  expect(wire.toolCalls).toEqual([{ stage: 'implementing', turn: 1, tool: 'Read', count: 2 }, { stage: 'implementing', turn: 2, tool: 'Edit', count: 1 }]);
  expect(JSON.stringify(wire)).not.toContain('/secret/x.ts');
});

it('groups CODEX-shaped tool calls onto the completed wire event', () => {
  const wire = toWire(turnOf([{ turn: 1, tool: 'command_execution' }, { turn: 2, tool: 'file_change' }], true));
  expect(wire.toolCalls).toEqual([{ stage: 'implementing', turn: 1, tool: 'command_execution', count: 1 }, { stage: 'implementing', turn: 2, tool: 'file_change', count: 1 }]);
});