import { normalizeClaudeTurn } from '../../packages/core/src/providers/normalize-claude.js';
import { __test as codexTest } from '../../packages/core/src/providers/codex-cli-session.js';

it('records one CLAUDE entry per tool_use block, tagged with its assistant-event turn', () => {
  const claude = normalizeClaudeTurn([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }, { type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/secret/x.ts' } }] } },
    { type: 'result', subtype: 'success', usage: {} },
  ] as never[], { durationMs: 1 });
  expect(claude.toolCalls).toEqual([{ turn: 1, tool: 'Read' }, { turn: 1, tool: 'Read' }, { turn: 2, tool: 'Edit' }]);
});

it('counts a CODEX item once even when item_started also fires', () => {
  const tracker = new codexTest.TurnTracker({ inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedNonReadTokens: 0 });
  tracker.consume({ kind: 'turn_started' });
  // item_started MUST NOT produce a second record for the same item.
  tracker.consume({ kind: 'item_started', item: { type: 'command_execution', command: 'rg x' } });
  tracker.consume({ kind: 'item_completed', item: { type: 'command_execution', command: 'rg x' } });
  tracker.consume({ kind: 'turn_started' });
  tracker.consume({ kind: 'item_started', item: { type: 'file_change', path: '/secret/x.ts' } });
  tracker.consume({ kind: 'item_completed', item: { type: 'file_change', path: '/secret/x.ts' } });
  expect(tracker.toolCalls).toEqual([{ turn: 1, tool: 'command_execution' }, { turn: 2, tool: 'file_change' }]);
});