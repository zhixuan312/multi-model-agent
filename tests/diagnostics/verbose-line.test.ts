import { composeVerboseLine, toVerboseFields } from '@zhixuan92/multi-model-agent-core/diagnostics/verbose-line';

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

describe('toVerboseFields', () => {
  it('converts camelCase keys to snake_case', () => {
    expect(toVerboseFields({ assignedTier: 'standard', usedTier: 'complex' }))
      .toEqual({ assigned_tier: 'standard', used_tier: 'complex' });
    expect(toVerboseFields({ implTier: 'complex', reviewerTier: 'standard', baseTier: 'standard' }))
      .toEqual({ impl_tier: 'complex', reviewer_tier: 'standard', base_tier: 'standard' });
    expect(toVerboseFields({ attemptCap: 3, wantedTier: 'complex' }))
      .toEqual({ attempt_cap: 3, wanted_tier: 'complex' });
    expect(toVerboseFields({ violatesSeparation: false, triggeringStatus: 'http_502' }))
      .toEqual({ violates_separation: false, triggering_status: 'http_502' });
  });

  it('drops batchId and taskIndex (already emitted as batch and task)', () => {
    expect(toVerboseFields({ batchId: 'abc', taskIndex: 0, loop: 'spec' }))
      .toEqual({ loop: 'spec' });
  });

  it('leaves snake_case and single-word keys unchanged', () => {
    expect(toVerboseFields({ duration_ms: 100, idle_ms: 50, cost_used_usd: 0.5 }))
      .toEqual({ duration_ms: 100, idle_ms: 50, cost_used_usd: 0.5 });
    expect(toVerboseFields({ from: 'a', to: 'b', loop: 'spec', attempt: 1 }))
      .toEqual({ from: 'a', to: 'b', loop: 'spec', attempt: 1 });
  });

  it('drops undefined values', () => {
    expect(toVerboseFields({ assignedTier: 'standard', triggeringStatus: undefined }))
      .toEqual({ assigned_tier: 'standard' });
  });

  it('preserves null', () => {
    expect(toVerboseFields({ usedTier: null })).toEqual({ used_tier: null });
  });

  it('produces composeVerboseLine-compatible keys for a fallback event', () => {
    const fields = toVerboseFields({
      batchId: 'b1', taskIndex: 0, loop: 'spec', attempt: 0, role: 'implementer',
      assignedTier: 'standard', usedTier: 'complex', reason: 'transport_failure',
      triggeringStatus: 'http_502', violatesSeparation: false,
    });
    expect(() => composeVerboseLine({
      event: 'fallback', ts: '2026-04-25T00:00:00.000Z', batch: 'b1', task: 0, ...fields,
    })).not.toThrow();
  });

  it('produces composeVerboseLine-compatible keys for a stage_change rework event', () => {
    const fields = toVerboseFields({
      from: 'spec_review', to: 'spec_rework', attempt: 1, attemptCap: 3,
      implTier: 'complex', reviewerTier: 'standard', escalated: true,
    });
    expect(() => composeVerboseLine({
      event: 'stage_change', ts: '2026-04-25T00:00:00.000Z', task: 0, ...fields,
    })).not.toThrow();
  });
});
