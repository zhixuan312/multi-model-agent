import { describe, it, expect, vi } from 'vitest';
import {
  runWithFallback,
  makeSyntheticRunResult,
  TRANSPORT_FAILURES,
  type UnavailableMap,
} from '../../packages/core/src/escalation/fallback.js';
import type { Provider, RunResult, AgentType } from '../../packages/core/src/types.js';
import { canonicalModelName } from '../../packages/core/src/routing/canonical-model.js';

function mockProvider(name: string, run: () => Promise<RunResult>, config?: unknown): Provider {
  return {
    name,
    config: (config ?? { type: 'codex', model: `mock-${name}` }) as never,
    run,
  };
}

function okResult(name: string): RunResult {
  return {
    status: 'ok',
    output: `from ${name}`,
    outputIsDiagnostic: false,
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.01, costDeltaVsParentUSD: 0 },
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    escalationLog: [],
  } as unknown as RunResult;
}

const isTransportFailure = (r: RunResult) => TRANSPORT_FAILURES.has(r.status);
const makeSynthetic = (assigned: AgentType) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable');

describe('runWithFallback — forbiddenModels (model-family separation)', () => {
  it('refuses fallback when only candidate matches implementer model family', async () => {
    // Both tiers use gpt-5.5 family models — forbiddenModels: ['gpt-5.5'] should block both
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'),
      { type: 'codex', model: 'gpt-5.5' });
    const complex = mockProvider('complex', async () => okResult('complex'),
      { type: 'codex', model: 'gpt-5.5-preview-20251001' });

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenModels: ['gpt-5.5'],
      call: (p) => p.run('test', {}),
    });

    expect(result.bothUnavailable).toBe(true);
    expect(result.unavailableReason).toBe('reviewer_separation_unsatisfiable');
  });

  it('canonicalizes forbidden model inputs before comparing', async () => {
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'),
      { type: 'codex', model: 'gpt-5.5-preview-20251001' });
    const complex = mockProvider('complex', async () => okResult('complex'),
      { type: 'codex', model: 'gpt-5.5' });

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenModels: ['gpt-5.5-preview-20251001'],
      call: (p) => p.run('test', {}),
    });

    expect(result.bothUnavailable).toBe(true);
    expect(result.unavailableReason).toBe('reviewer_separation_unsatisfiable');
  });

  it('allows fallback when candidate model differs from forbidden models', async () => {
    const map: UnavailableMap = new Map();
    // standard uses gpt-5.5 (forbidden), complex uses claude-haiku-4-5 (different family)
    const standard = mockProvider('standard', async () => okResult('standard'),
      { type: 'codex', model: 'gpt-5.5' });
    const complex = mockProvider('complex', async () => okResult('complex'),
      { type: 'claude', model: 'claude-haiku-4-5' });

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      getStatus: (r) => r.status,
      makeSyntheticFailure: makeSynthetic,
      forbiddenModels: ['gpt-5.5'],
      call: (p) => p.run('test', {}),
    });

    expect(result.fallbackFired).toBe(true);
    expect(result.usedTier).toBe('complex');
    expect(result.bothUnavailable).toBe(false);
  });

  it('skips candidate when canonicalModelName resolution fails (fail-closed)', async () => {
    const map: UnavailableMap = new Map();
    // A provider with a null config will cause canonicalModelName to fail
    const standard = { name: 'standard', config: null as any, run: async () => okResult('standard') } as Provider;
    const complexCfg = { type: 'claude', model: 'claude-haiku-4-5' };
    const complex = mockProvider('complex', async () => okResult('complex'), complexCfg);

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      getStatus: (r) => r.status,
      makeSyntheticFailure: makeSynthetic,
      forbiddenModels: ['gpt-5.5'],
      call: (p) => p.run('test', {}),
    });

    // canonicalModelName(null.config.model) throws → fail-closed → skip standard
    // complex has different model → fallback succeeds
    expect(result.fallbackFired).toBe(true);
    expect(result.usedTier).toBe('complex');
    expect(result.bothUnavailable).toBe(false);
  });

  it('works alongside forbiddenIdentities — both block independently', async () => {
    const map: UnavailableMap = new Map();
    // Both tiers are Claude models — forbiddenIdentities blocks one, forbiddenModels blocks the other
    const standardCfg = { type: 'claude', model: 'claude-sonnet-4-6' };
    const complexCfg = { type: 'openai-compatible', model: 'gpt-5.5', baseUrl: 'https://api.example.com' };
    const standard = mockProvider('standard', async () => okResult('standard'), standardCfg);
    const complex = mockProvider('complex', async () => okResult('complex'), complexCfg);

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      getStatus: (r) => r.status,
      makeSyntheticFailure: makeSynthetic,
      // canonicalModelName('claude-sonnet-4-6') resolves to 'claude-sonnet'
      forbiddenModels: ['claude-sonnet'],
      call: (p) => p.run('test', {}),
    });

    // standard blocked by forbiddenModels, complex is different family → fallback succeeds
    expect(result.fallbackFired).toBe(true);
    expect(result.usedTier).toBe('complex');
    expect(result.bothUnavailable).toBe(false);
  });

  it('surfaces reviewer_separation_unsatisfiable when assigned blocked by forbiddenModels and alt not configured', async () => {
    // Assigned standard tier uses gpt-5.5 (forbidden), complex tier is not configured.
    // unavailableReason must be reviewer_separation_unsatisfiable, not not_configured,
    // so adaptForAllTiersUnavailable can set the correct errorCode.
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'),
      { type: 'codex', model: 'gpt-5.5' });

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : undefined),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenModels: ['gpt-5.5'],
      call: (p) => p.run('test', {}),
    });

    expect(result.bothUnavailable).toBe(true);
    expect(result.unavailableReason).toBe('reviewer_separation_unsatisfiable');
  });

  it('no-op when forbiddenModels is empty', async () => {
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'));

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : undefined),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenModels: [],
      call: (p) => p.run('test', {}),
    });

    expect(result.bothUnavailable).toBe(false);
    expect(result.usedTier).toBe('standard');
  });
});

describe('canonicalModelName', () => {
  it('returns the canonical prefix for a known model', () => {
    // gpt-5.5 is a known profile prefix
    const result = canonicalModelName('gpt-5.5-preview-20251001');
    expect(result).toBe('gpt-5.5');
  });

  it('returns the raw string when no profile matches', () => {
    const result = canonicalModelName('some-unknown-model-v1');
    expect(result).toBe('some-unknown-model-v1');
  });

  it('returns the raw prefix for a bare model name', () => {
    const result = canonicalModelName('gpt-5.5');
    expect(result).toBe('gpt-5.5');
  });
});
