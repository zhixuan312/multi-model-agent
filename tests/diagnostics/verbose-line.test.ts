import { composeVerboseLine } from '@zhixuan92/multi-model-agent-core/diagnostics/verbose-line';

describe('composeVerboseLine', () => {
  it('emits canonical shape with event and ts', () => {
    const line = composeVerboseLine({ event: 'task_started', ts: '2026-04-25T12:00:00.000Z', task: 0, provider: 'codex', agent_type: 'standard' });
    expect(line).toBe('[mmagent verbose] event=task_started ts=2026-04-25T12:00:00.000Z task=0 provider=codex agent_type=standard');
  });

  it('quotes values containing spaces or equals', () => {
    const line = composeVerboseLine({ event: 'tool_call', ts: '2026-04-25T12:00:00.000Z', task: 0, tool: 'bash', args_summary: 'ls -la /tmp' });
    expect(line).toContain('args_summary="ls -la /tmp"');
  });

  it('escapes backslash, quote, newline, cr, tab, control chars', () => {
    const line = composeVerboseLine({ event: 'text_emission', ts: '2026-04-25T12:00:00.000Z', task: 0, preview: 'line1\nline2\twith \"quote\" and \\back\u0001ctrl' });
    expect(line).toContain('preview="line1\\nline2\\twith \\"quote\\" and \\\\back\\u0001ctrl"');
  });

  it('emits null as bare token, not empty string', () => {
    const line = composeVerboseLine({ event: 'verify_step', ts: '2026-04-25T12:00:00.000Z', task: 0, command: 'npm test', status: 'spawn_error', exit_code: null, signal: null, duration_ms: 12 });
    expect(line).toMatch(/exit_code=null /);
    expect(line).toMatch(/signal=null /);
  });

  it('preview-only free text rule: other keys reject newlines', () => {
    expect(() => composeVerboseLine({ event: 'task_started', ts: '2026-04-25T12:00:00.000Z', task: 0, provider: 'has\nnewline', agent_type: 'standard' })).toThrow(/non-preview/);
  });

  it('produces single physical line', () => {
    const line = composeVerboseLine({ event: 'text_emission', ts: '2026-04-25T12:00:00.000Z', task: 0, preview: 'a\nb\rc\td' });
    expect(line.split('\n')).toHaveLength(1);
    expect(line.split('\r')).toHaveLength(1);
  });

  it('rejects keys containing spaces, equals, or non-snake_case chars', () => {
    expect(() => composeVerboseLine({ event: 'x', ts: '2026-04-25T12:00:00.000Z', 'bad key': 'v' } as any)).toThrow();
    expect(() => composeVerboseLine({ event: 'x', ts: '2026-04-25T12:00:00.000Z', 'bad=key': 'v' } as any)).toThrow();
    expect(() => composeVerboseLine({ event: 'x', ts: '2026-04-25T12:00:00.000Z', 'BadKey': 'v' } as any)).toThrow();
  });

  it('rejects non-primitive values', () => {
    expect(() => composeVerboseLine({ event: 'x', ts: '2026-04-25T12:00:00.000Z', obj: {} } as any)).toThrow();
  });
});
