import { vi, beforeEach, afterEach } from 'vitest';
import {
  validateCompletion,
  validateCoverage,
  buildRePrompt,
  sameDegenerateOutput,
  trimProgressTrace,
  resolveInputTokenSoftLimit,
  checkWatchdogThreshold,
  TRACE_MAX_EVENTS,
  TRACE_MAX_CHARS,
  TRACE_DROP_PRIORITY,
  WATCHDOG_WARNING_RATIO,
  WATCHDOG_FORCE_SALVAGE_RATIO,
  logWatchdogEvent,
  type WatchdogEventDetails,
  validateSubAgentOutput,
  THINKING_DIAGNOSTIC_MARKER,
} from '../../packages/core/src/runners/supervision.js';
import type { ProviderConfig } from '../../packages/core/src/types.js';
import type { ModelProfile } from '../../packages/core/src/routing/model-profiles.js';

describe('validateCompletion — empty detection', () => {
  it('detects an empty string', () => {
    const result = validateCompletion('');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });

  it('detects whitespace-only as empty', () => {
    const result = validateCompletion('   \n\t  ');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });
});

describe('validateCompletion — thinking-only detection', () => {
  it('detects when stripThinkingTags would reduce to the diagnostic marker', () => {
    const input = '[model final message contained only <think>...</think> reasoning, no plain-text answer]';
    const result = validateCompletion(input);
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('thinking_only');
  });
});

describe('validateCompletion — fragment ending detection', () => {
  it('detects "let me check" continuation phrase', () => {
    const result = validateCompletion('Now let me check the SSE hook and BottomNav:');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('fragment');
    expect(result.tail).toContain('let me check');
  });

  it('detects bare colon ending', () => {
    const result = validateCompletion('Here is what I found:');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('fragment');
  });

  it('detects "i\'ll continue" phrase', () => {
    const result = validateCompletion("I'll continue exploring the codebase");
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('fragment');
  });

  it('does NOT trigger on a long valid response that happens to contain "let me"', () => {
    const longText = 'This is a complete answer. Let me also note that everything is working. ' +
      'There are no further issues. The system has been thoroughly verified across all '.repeat(5);
    const result = validateCompletion(longText);
    expect(result.valid).toBe(true);
  });
});

describe('validateCompletion — no terminator detection', () => {
  it('detects short text with no terminal punctuation and no markdown', () => {
    const result = validateCompletion('this is some text without a proper end');
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('no_terminator');
  });

  it('does NOT trigger on short text with terminal period', () => {
    const result = validateCompletion('this is short but complete.');
    expect(result.valid).toBe(true);
  });

  it('does NOT trigger on short text with markdown header', () => {
    const result = validateCompletion('# Heading\n\nSome content');
    expect(result.valid).toBe(true);
  });

  it('does NOT trigger on short text with code fence', () => {
    const result = validateCompletion('Here:\n```\ncode\n```');
    expect(result.valid).toBe(true);
  });
});

describe('validateCoverage — empty expectation is a no-op', () => {
  it('returns valid when no coverage rules are declared', () => {
    const result = validateCoverage('anything at all', {});
    expect(result.valid).toBe(true);
  });
});

describe('validateCoverage — minSections', () => {
  it('passes when the default section pattern is met', () => {
    const result = validateCoverage('# heading\n\n## one\ntext\n\n## two\ntext', {
      minSections: 2,
    });
    expect(result.valid).toBe(true);
  });

  it('fails when the default section pattern count is too low', () => {
    const result = validateCoverage('## only one\ncontent', {
      minSections: 2,
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('insufficient_coverage');
    expect(result.reason).toContain('only 1 sections found');
  });

  it('supports a custom sectionPattern', () => {
    const result = validateCoverage('Section: one\n\nSection: two', {
      minSections: 2,
      sectionPattern: '^Section: ',
    });
    expect(result.valid).toBe(true);
  });

  it('reports invalid sectionPattern regexes', () => {
    const result = validateCoverage('## one', {
      minSections: 1,
      sectionPattern: '[',
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('insufficient_coverage');
    expect(result.reason).toContain('invalid sectionPattern regex');
  });
});

describe('validateCoverage — requiredMarkers', () => {
  it('passes when all required markers are present', () => {
    const result = validateCoverage('alpha beta gamma', {
      requiredMarkers: ['alpha', 'beta', 'gamma'],
    });
    expect(result.valid).toBe(true);
  });

  it('fails when one required marker is missing', () => {
    const result = validateCoverage('alpha gamma', {
      requiredMarkers: ['alpha', 'beta', 'gamma'],
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('insufficient_coverage');
    expect(result.reason).toContain('only 2 of 3 required markers found');
    expect(result.reason).toContain('missing: beta');
  });

  it('truncates long missing marker lists after five entries', () => {
    const result = validateCoverage('kept-marker', {
      requiredMarkers: [
        'kept-marker',
        'missing-a',
        'missing-b',
        'missing-c',
        'missing-d',
        'missing-e',
        'missing-f',
        'missing-g',
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('insufficient_coverage');
    expect(result.reason).toContain('missing: missing-a, missing-b, missing-c, missing-d, missing-e (+2 more)');
  });

  it('treats an empty requiredMarkers array as a no-op', () => {
    const result = validateCoverage('anything', {
      requiredMarkers: [],
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateCoverage — combined checks', () => {
  it('fails with the first failing reason when minSections fails before requiredMarkers', () => {
    const result = validateCoverage('## only one\ncontent', {
      minSections: 2,
      requiredMarkers: ['missing-marker'],
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('insufficient_coverage');
    expect(result.reason).toContain('only 1 sections found');
  });

  it('passes when both minSections and requiredMarkers pass', () => {
    const result = validateCoverage('## one\nmarker\n\n## two\nmarker', {
      minSections: 2,
      requiredMarkers: ['marker'],
    });
    expect(result.valid).toBe(true);
  });
});

describe('buildRePrompt — empty', () => {
  it('produces a re-prompt that mentions the empty response', () => {
    const result = validateCompletion('');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('previous response was empty');
    expect(prompt).toContain('plain text');
  });
});

describe('buildRePrompt — thinking_only', () => {
  it('produces a re-prompt that mentions the <think> tags', () => {
    const result = validateCompletion('[model final message contained only <think>...</think> reasoning, no plain-text answer]');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('<think>');
    expect(prompt).toContain('plain text');
  });
});

describe('buildRePrompt — fragment', () => {
  it('quotes the actual fragment tail back at the model', () => {
    const result = validateCompletion('Now let me check the SSE hook and BottomNav:');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('exploration fragment');
    expect(prompt).toContain('let me check the SSE hook and BottomNav:');
  });
});

describe('buildRePrompt — no_terminator', () => {
  it('produces a re-prompt that nudges toward a complete answer', () => {
    const result = validateCompletion('this is some text without a proper end');
    const prompt = buildRePrompt(result);
    expect(prompt).toContain('mid-thought');
  });
});

describe('buildRePrompt — insufficient_coverage', () => {
  it('tells the model not to restart and to append missing items', () => {
    const prompt = buildRePrompt({
      valid: false,
      kind: 'insufficient_coverage',
      reason: 'only 2 of 3 required markers found, missing: beta',
    });
    expect(prompt).toContain('structurally valid but does not cover everything the brief required');
    expect(prompt).toContain('Do NOT restart from the beginning');
    expect(prompt).toContain('append the missing sections');
  });
});

describe('trace trimming exports', () => {
  it('exposes the documented constants', () => {
    expect(TRACE_MAX_EVENTS).toBe(80);
    expect(TRACE_MAX_CHARS).toBe(16_384);
    expect(TRACE_DROP_PRIORITY.text_emission).toBe(1);
    expect(TRACE_DROP_PRIORITY.tool_call).toBe(2);
    expect(TRACE_DROP_PRIORITY.turn_start).toBe(100);
    expect(TRACE_DROP_PRIORITY.turn_complete).toBe(100);
    expect(TRACE_DROP_PRIORITY.injection).toBe(100);
    expect(TRACE_DROP_PRIORITY.done).toBe(100);
  });
});

describe('trimProgressTrace', () => {
  it('returns an empty array for empty input', () => {
    expect(trimProgressTrace([])).toEqual([]);
  });

  it('returns the same array when both bounds are already satisfied', () => {
    const events = [
      { kind: 'turn_start', turn: 1, provider: 'codex' },
      { kind: 'done', status: 'ok' },
    ] as const;
    expect(trimProgressTrace(events)).toBe(events);
  });

  it('trims droppable events to satisfy the count bound', () => {
    const events = Array.from({ length: 81 }, (_, i) => ({
      kind: 'text_emission' as const,
      turn: i + 1,
      chars: 1,
      preview: 'x',
    }));
    const trimmed = trimProgressTrace(events);
    expect(trimmed).toHaveLength(81);
    expect(trimmed.filter((event) => event.kind === 'text_emission')).toHaveLength(80);
    expect(trimmed[trimmed.length - 1]).toEqual({
      kind: '_trimmed',
      droppedCount: 1,
      droppedKinds: { text_emission: 1 },
    });
  });

  it('trims by priority when the size bound is exceeded', () => {
    const events = [
      { kind: 'turn_start', turn: 1, provider: 'codex' },
      ...Array.from({ length: 10 }, (_, i) => ({
        kind: 'tool_call' as const,
        turn: i + 1,
        toolSummary: 'tool'.repeat(4000),
      })),
    ];
    const trimmed = trimProgressTrace(events);
    expect(trimmed.length).toBeLessThan(events.length);
    expect(trimmed[0]).toEqual({ kind: 'turn_start', turn: 1, provider: 'codex' });
    expect(trimmed[trimmed.length - 1]).toMatchObject({ kind: '_trimmed' });
  });

  it('boundary fits but merged trace over 16KB → drops droppable events to satisfy remaining byte budget', () => {
    // Boundary consumes part of the 16KB budget, so droppable entries must fit
    // within the remaining bytes rather than the full cap.
    const boundary = { kind: 'turn_start' as const, turn: 1, provider: 'b'.repeat(9000) };
    const droppable = { kind: 'text_emission' as const, turn: 1, chars: 1, preview: 'd'.repeat(9000) };
    const events = [boundary, droppable];
    const trimmed = trimProgressTrace(events);
    expect(trimmed[0]).toEqual(boundary);
    expect(trimmed.some((event) => event.kind === 'text_emission')).toBe(false);
    const marker = trimmed[1];
    expect(marker).toMatchObject({
      kind: '_trimmed',
      droppedCount: 1,
      droppedKinds: { text_emission: 1 },
    });
  });

  it('keeps all 100 never-drop turn_start events and marks boundary-cap pressure', () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      kind: 'turn_start' as const,
      turn: i + 1,
      provider: `codex-${'x'.repeat(20)}`,
    }));
    const trimmed = trimProgressTrace(events);
    expect(trimmed.filter((event) => event.kind === 'turn_start')).toHaveLength(100);
    const marker = trimmed.find((event) => event.kind === '_trimmed');
    expect(marker).toEqual(
      expect.objectContaining({
        kind: '_trimmed',
        droppedCount: 0,
        capExceededByBoundaryEvents: true,
      }),
    );
  });

  it('preserves never-drop boundary strings in full when boundary-cap pressure is reported', () => {
    const provider = 'provider-' + 'x'.repeat(400);
    const events = Array.from({ length: 100 }, (_, i) => ({
      kind: 'turn_start' as const,
      turn: i + 1,
      provider: `${provider}-${i}`,
    }));
    const trimmed = trimProgressTrace(events);
    expect(trimmed.filter((event) => event.kind === 'turn_start')).toHaveLength(100);
    const first = trimmed.find((event) => event.kind === 'turn_start');
    expect(first).toMatchObject({ provider: `${provider}-0` });
    expect(trimmed.find((event) => event.kind === '_trimmed')).toEqual(
      expect.objectContaining({
        kind: '_trimmed',
        capExceededByBoundaryEvents: true,
      }),
    );
  });

  it('keeps all never-drop turn_start events while dropping all text emissions when boundary events consume the nominal budget', () => {
    const events = [
      ...Array.from({ length: 100 }, (_, i) => ({
        kind: 'turn_start' as const,
        turn: i + 1,
        provider: `codex-${'x'.repeat(12)}`,
      })),
      ...Array.from({ length: 500 }, (_, i) => ({
        kind: 'text_emission' as const,
        turn: i + 1,
        chars: 1,
        preview: 'y'.repeat(120),
      })),
    ];
    const trimmed = trimProgressTrace(events);
    expect(trimmed.filter((event) => event.kind === 'turn_start')).toHaveLength(100);
    expect(trimmed.some((event) => event.kind === 'text_emission')).toBe(false);
    const marker = trimmed.find((event) => event.kind === '_trimmed');
    expect(marker).toEqual(
      expect.objectContaining({
        kind: '_trimmed',
        capExceededByBoundaryEvents: true,
      }),
    );
    if (marker && marker.kind === '_trimmed') {
      expect(marker.droppedCount).toBeGreaterThan(0);
      expect(marker.droppedKinds.text_emission).toBeGreaterThan(0);
    }
  });

  it('drops low-priority events until both bounds are satisfied', () => {
    const events = [
      { kind: 'turn_start', turn: 1, provider: 'codex' },
      ...Array.from({ length: 84 }, (_, i) => ({
        kind: i % 2 === 0 ? ('text_emission' as const) : ('tool_call' as const),
        turn: i + 1,
        ...(i % 2 === 0
          ? { chars: 1, preview: 'x'.repeat(1000) }
          : { toolSummary: 'y'.repeat(100) }),
      })),
    ];
    const trimmed = trimProgressTrace(events);
    expect(trimmed.length).toBeLessThan(events.length);
    expect(trimmed[trimmed.length - 1]).toMatchObject({ kind: '_trimmed' });
  });

  it('preserves oversized never-drop events and marks boundary-cap pressure', () => {
    const events = Array.from({ length: 24 }, (_, i) => ({
      kind: 'turn_start' as const,
      turn: i + 1,
      provider: `codex-${'x'.repeat(1500)}`,
    }));
    const trimmed = trimProgressTrace(events);
    expect(trimmed.filter((event) => event.kind === 'turn_start')).toHaveLength(events.length);
    expect(trimmed[0]).toMatchObject({ provider: events[0].provider });
    expect(trimmed.find((event) => event.kind === '_trimmed')).toEqual(
      expect.objectContaining({
        kind: '_trimmed',
        droppedCount: 0,
        capExceededByBoundaryEvents: true,
      }),
    );
  });

  it('preserves all never-drop boundary events when fallback-style pressure is exercised', () => {
    const events = [
      { kind: 'turn_start', turn: 1, provider: 'codex' },
      ...Array.from({ length: 15 }, (_, i) => ({
        kind: 'text_emission' as const,
        turn: i + 1,
        chars: 1,
        preview: 'x'.repeat(1000),
      })),
      { kind: 'escalation_start', previousProvider: 'codex', previousReason: 'escalate', nextProvider: 'claude' },
      ...Array.from({ length: 15 }, (_, i) => ({
        kind: 'tool_call' as const,
        turn: i + 16,
        toolSummary: 'y'.repeat(1000),
      })),
      { kind: 'injection', injectionType: 'reground', turn: 31, contentLengthChars: 123 },
      { kind: 'injection', injectionType: 'supervise_empty', turn: 32, contentLengthChars: 456 },
      { kind: 'done', status: 'ok' },
    ];
    const trimmed = trimProgressTrace(events);
    expect(trimmed.some((event) => event.kind === 'turn_start')).toBe(true);
    expect(trimmed.some((event) => event.kind === 'escalation_start')).toBe(true);
    expect(trimmed.filter((event) => event.kind === 'injection')).toHaveLength(2);
    expect(trimmed.some((event) => event.kind === 'done')).toBe(true);
    expect(trimmed.find((event) => event.kind === '_trimmed')).toEqual(
      expect.objectContaining({
        kind: '_trimmed',
      }),
    );
  });

  it('drops only droppable events before higher-priority events in a large trace', () => {
    const events = [
      ...Array.from({ length: 500 }, (_, i) => ({
        kind: 'text_emission' as const,
        turn: i + 1,
        chars: 1,
        preview: 'x'.repeat(1000),
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        kind: 'turn_start' as const,
        turn: i + 1,
        provider: 'codex',
      })),
    ];
    const trimmed = trimProgressTrace(events);
    expect(trimmed.length).toBeLessThan(events.length);
    expect(trimmed.some((event) => event.kind === 'turn_start')).toBe(true);
    const marker = trimmed.find((event) => event.kind === '_trimmed');
    expect(marker).toEqual(
      expect.objectContaining({
        kind: '_trimmed',
        droppedCount: expect.any(Number),
      }),
    );
    if (marker && marker.kind === '_trimmed') {
      expect(marker.droppedCount).toBeGreaterThan(0);
      expect(marker.droppedKinds.text_emission).toBeGreaterThan(0);
    }
  });

  it('preserves never-drop events when fallback logic is exercised on droppable events only', () => {
    const events = [
      { kind: 'turn_start', turn: 1, provider: `codex-${'x'.repeat(400)}` },
      ...Array.from({ length: 30 }, (_, i) => ({
        kind: 'text_emission' as const,
        turn: i + 2,
        chars: 1,
        preview: 'y'.repeat(2000),
      })),
      { kind: 'escalation_start', previousProvider: `codex-${'x'.repeat(400)}`, previousReason: 'need more room', nextProvider: `claude-${'x'.repeat(400)}` },
      { kind: 'injection', injectionType: 'reground', turn: 20, contentLengthChars: 123 },
      { kind: 'done', status: 'ok' },
    ];
    const trimmed = trimProgressTrace(events);
    expect(trimmed.some((event) => event.kind === 'turn_start')).toBe(true);
    expect(trimmed.some((event) => event.kind === 'escalation_start')).toBe(true);
    expect(trimmed.some((event) => event.kind === 'injection')).toBe(true);
    expect(trimmed.some((event) => event.kind === 'done')).toBe(true);
    expect(trimmed.some((event) => event.kind === 'text_emission')).toBe(true);
    expect(trimmed.find((event) => event.kind === '_trimmed')).toEqual(
      expect.objectContaining({
        kind: '_trimmed',
      }),
    );
  });
});

describe('sameDegenerateOutput', () => {
  it('returns true for byte-identical outputs', () => {
    expect(sameDegenerateOutput('foo', 'foo')).toBe(true);
  });

  it('returns false for different outputs', () => {
    expect(sameDegenerateOutput('foo', 'bar')).toBe(false);
  });

  it('returns false when only one is empty', () => {
    expect(sameDegenerateOutput('foo', '')).toBe(false);
  });

  it('returns true for two empty strings (identical garbage twice)', () => {
    expect(sameDegenerateOutput('', '')).toBe(true);
  });

  it('returns true for two whitespace-only strings (same after trim)', () => {
    expect(sameDegenerateOutput('   ', '\t')).toBe(true);
  });
});

describe('resolveInputTokenSoftLimit — precedence', () => {
  const profile: ModelProfile = {
    tier: 'standard',
    bestFor: 'test',
    supportsEffort: false,
    inputTokenSoftLimit: 500_000,
  } as ModelProfile;

  it('uses provider config when set', () => {
    const config: ProviderConfig = {
      type: 'codex',
      model: 'gpt-5-codex',
      inputTokenSoftLimit: 200_000,
    };
    expect(resolveInputTokenSoftLimit(config, profile)).toBe(200_000);
  });

  it('falls back to model profile when provider config is unset', () => {
    const config: ProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    expect(resolveInputTokenSoftLimit(config, profile)).toBe(500_000);
  });
});

describe('checkWatchdogThreshold', () => {
  it('exposes the documented 80% / 95% ratios as exports', () => {
    expect(WATCHDOG_WARNING_RATIO).toBe(0.80);
    expect(WATCHDOG_FORCE_SALVAGE_RATIO).toBe(0.95);
  });

  it('returns "ok" below 80% of the limit', () => {
    expect(checkWatchdogThreshold(700_000, 1_000_000)).toBe('ok');
  });

  it('returns "warning" at exactly 80% of the limit', () => {
    expect(checkWatchdogThreshold(800_000, 1_000_000)).toBe('warning');
  });

  it('returns "warning" between 80% and 95%', () => {
    expect(checkWatchdogThreshold(900_000, 1_000_000)).toBe('warning');
  });

  it('returns "force_salvage" at exactly 95% of the limit', () => {
    expect(checkWatchdogThreshold(950_000, 1_000_000)).toBe('force_salvage');
  });

  it('returns "force_salvage" above 95%', () => {
    expect(checkWatchdogThreshold(1_100_000, 1_000_000)).toBe('force_salvage');
  });

  // Regression for Task 2 review fix #1: a silent 'ok' on an invalid
  // softLimit would mask upstream bugs in runners that call this directly.
  it('throws on softLimit === 0', () => {
    expect(() => checkWatchdogThreshold(100, 0)).toThrow(/positive finite number/);
  });

  it('throws on negative softLimit', () => {
    expect(() => checkWatchdogThreshold(100, -1)).toThrow(/positive finite number/);
  });

  it('throws on NaN softLimit', () => {
    expect(() => checkWatchdogThreshold(100, Number.NaN)).toThrow(/positive finite number/);
  });

  it('throws on Infinity softLimit', () => {
    expect(() => checkWatchdogThreshold(100, Number.POSITIVE_INFINITY)).toThrow(
      /positive finite number/,
    );
  });
});

describe('logWatchdogEvent — MULTI_MODEL_DEBUG output', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  const baseDetails: WatchdogEventDetails = {
    provider: 'codex',
    model: 'gpt-5-codex',
    turn: 5,
    inputTokens: 800_000,
    softLimit: 1_000_000,
    scratchpadChars: 0,
  };

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('emits nothing when MULTI_MODEL_DEBUG is unset', () => {
    logWatchdogEvent('warning', { ...baseDetails });
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('emits a warning line when MULTI_MODEL_DEBUG=1 and status is warning', () => {
    vi.stubEnv('MULTI_MODEL_DEBUG', '1');
    logWatchdogEvent('warning', { ...baseDetails });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('WATCHDOG warning'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('provider=codex'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('inputTokens=800000'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('percentOfLimit=80'));
  });

  it('emits a force_salvage line when status is force_salvage', () => {
    vi.stubEnv('MULTI_MODEL_DEBUG', '1');
    logWatchdogEvent('force_salvage', {
      ...baseDetails,
      turn: 18,
      inputTokens: 950_000,
      scratchpadChars: 30000,
    });
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('WATCHDOG force_salvage'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('scratchpadChars=30000'));
  });
});

describe('validateSubAgentOutput (coordinator)', () => {
  it('empty output always fails even when expectedCoverage is declared', () => {
    const result = validateSubAgentOutput('', {
      expectedCoverage: { minSections: 2 },
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });

  it('thinking_only output always fails even when expectedCoverage is declared', () => {
    const result = validateSubAgentOutput(THINKING_DIAGNOSTIC_MARKER, {
      expectedCoverage: { minSections: 2 },
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('thinking_only');
  });

  it('expectedCoverage passing makes short terminator-less output valid', () => {
    const result = validateSubAgentOutput('verdict: pass, section-alpha, section-beta', {
      expectedCoverage: {
        requiredMarkers: ['section-alpha', 'section-beta'],
      },
    });
    expect(result.valid).toBe(true);
  });

  it('expectedCoverage failing propagates as insufficient_coverage', () => {
    const result = validateSubAgentOutput('verdict: pass, section-alpha', {
      expectedCoverage: {
        requiredMarkers: ['section-alpha', 'section-beta'],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('insufficient_coverage');
  });

  it('skipCompletionHeuristic: true makes a short terminator-less output valid without coverage', () => {
    const result = validateSubAgentOutput('minimax,ok,0.02,5m 30s', {
      skipCompletionHeuristic: true,
    });
    expect(result.valid).toBe(true);
  });

  it('skipCompletionHeuristic: true still fails on empty', () => {
    const result = validateSubAgentOutput('', { skipCompletionHeuristic: true });
    expect(result.valid).toBe(false);
    expect(result.kind).toBe('empty');
  });

  it('default (no opts) matches validateCompletion — no_terminator for short terminator-less output', () => {
    const text = 'verdict: pass';
    const coord = validateSubAgentOutput(text);
    const direct = validateCompletion(text);
    expect(coord).toEqual(direct);
    expect(coord.valid).toBe(false);
    expect(coord.kind).toBe('no_terminator');
  });

  it('default (no opts) matches validateCompletion — long prose is valid', () => {
    const text = 'This is a long explanation. '.repeat(20);
    const coord = validateSubAgentOutput(text);
    const direct = validateCompletion(text);
    expect(coord).toEqual(direct);
    expect(coord.valid).toBe(true);
  });
});
