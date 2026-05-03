import { describe, it, expect } from 'vitest';
import {
  runWithFallback,
  makeSyntheticRunResult,
  TRANSPORT_FAILURES,
  type UnavailableMap,
} from '../../packages/core/src/escalation/fallback.js';
import type { Provider, RunResult, AgentType } from '../../packages/core/src/types.js';

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

describe('Task 23: forbiddenTiers gates reviewer separation by tier', () => {
  it('refuses fallback when only candidate is the implementer tier', async () => {
    // Both standard and complex are available, but implementer is on standard.
    // forbiddenTiers: ['standard'] blocks standard for the reviewer,
    // and complex is also the same tier... actually only standard is forbidden.
    // When assignee=standard, forbiddenTiers=['standard'] → standard skipped,
    // fallback to complex (different tier) → should succeed.
    // For this test: we want both tiers to be the same forbidden tier,
    // i.e. only one tier is configured → fallback fails.
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'),
      { type: 'codex', model: 'gpt-5.5' });

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : undefined),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenTiers: ['standard'],
      call: (p) => p.run('test', {}),
    });

    expect(result.bothUnavailable).toBe(true);
    expect(result.unavailableReason).toBe('reviewer_separation_unsatisfiable');
  });

  it('runs cleanly when standard and complex map to the same model but different tiers', async () => {
    // User config: standard.model = complex.model = 'deepseek-v4-pro' (both available)
    // Implementer is standard; reviewer routes to complex (other tier).
    // forbiddenTiers: ['standard'] blocks standard for reviewer,
    // but complex is a different tier → R3 silent because tiers differ.
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'),
      { type: 'codex', model: 'deepseek-v4-pro' });
    const complex = mockProvider('complex', async () => okResult('complex'),
      { type: 'openai-compatible', model: 'deepseek-v4-pro', baseUrl: 'https://api.example.com' });

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      getStatus: (r) => r.status,
      makeSyntheticFailure: makeSynthetic,
      forbiddenTiers: ['standard'],
      call: (p) => p.run('test', {}),
    });

    // standard is forbidden (same tier as implementer) → falls back to complex
    expect(result.fallbackFired).toBe(true);
    expect(result.usedTier).toBe('complex');
    expect(result.bothUnavailable).toBe(false);
  });

  it('allows fallback when candidate tier differs from forbidden tier', async () => {
    const map: UnavailableMap = new Map();
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
      forbiddenTiers: ['standard'],
      call: (p) => p.run('test', {}),
    });

    // standard is forbidden tier → falls back to complex (different tier)
    expect(result.fallbackFired).toBe(true);
    expect(result.usedTier).toBe('complex');
    expect(result.bothUnavailable).toBe(false);
  });

  it('surfaces reviewer_separation_unsatisfiable when assigned blocked by forbiddenTiers and alt not configured', async () => {
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'),
      { type: 'codex', model: 'gpt-5.5' });

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : undefined),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenTiers: ['standard'],
      call: (p) => p.run('test', {}),
    });

    expect(result.bothUnavailable).toBe(true);
    expect(result.unavailableReason).toBe('reviewer_separation_unsatisfiable');
  });

  it('no-op when forbiddenTiers is empty', async () => {
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'));

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : undefined),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenTiers: [],
      call: (p) => p.run('test', {}),
    });

    expect(result.bothUnavailable).toBe(false);
    expect(result.usedTier).toBe('standard');
  });

  it('works alongside forbiddenIdentities — both block independently', async () => {
    // forbiddenIdentities blocks complex (same canonical identity as some target),
    // forbiddenTiers blocks standard (implementer tier).
    // standard (assignee, forbidden by tier) + complex (forbidden by identity) → both blocked.
    const map: UnavailableMap = new Map();
    const cfg = { type: 'codex' as const, model: 'gpt-5.5' };
    const standard = mockProvider('standard', async () => okResult('standard'), cfg);
    const complex = mockProvider('complex', async () => okResult('complex'), cfg);
    const { canonicalIdentity } = await import('../../packages/core/src/routing/canonical-model-identity.js');
    const identity = canonicalIdentity(cfg);

    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      forbiddenIdentities: [identity],
      forbiddenTiers: ['standard'],
      call: (p) => p.run('test', {}),
    });

    // standard blocked by forbiddenTiers, complex blocked by forbiddenIdentities
    expect(result.bothUnavailable).toBe(true);
  });
});
