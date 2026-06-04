import { describe, it, expect } from 'vitest';
import { mapProviderEventToPlainEntry, PROVIDER_EVENT_NAMES, PlainLogEntrySchema } from '../../packages/core/src/events/plain-log-entry.js';

describe('mapProviderEventToPlainEntry', () => {
  it('produces valid entries for all 20 provider event names', () => {
    expect(PROVIDER_EVENT_NAMES).toHaveLength(20);
    for (const name of PROVIDER_EVENT_NAMES) {
      const provider = name.startsWith('claude') ? 'claude' as const : 'codex' as const;
      const entry = mapProviderEventToPlainEntry(provider, name, { turn: 1 });
      expect(() => PlainLogEntrySchema.parse(entry)).not.toThrow();
      expect(entry.fields.provider).toBe(provider);
      expect(entry.fields.event).toBe(name);
    }
  });

  it('JSON-stringifies object-valued fields with _json suffix', () => {
    const entry = mapProviderEventToPlainEntry('claude', 'claude_tool_call', { turn: 1, tool: 'Read', input: { file: '/a' } });
    expect(entry.fields.input_json).toBe('{"file":"/a"}');
    expect(entry.fields.input).toBeUndefined();
  });

  it('preserves primitive fields as-is', () => {
    const entry = mapProviderEventToPlainEntry('codex', 'codex_command_completed', { turn: 2, command: 'ls', exit_code: 0, signal: null, duration_ms: 50 });
    expect(entry.fields.command).toBe('ls');
    expect(entry.fields.exit_code).toBe(0);
    expect(entry.fields.signal).toBeNull();
  });
});
