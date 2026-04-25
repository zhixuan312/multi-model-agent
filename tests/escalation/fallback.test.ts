import { describe, it, expect, vi } from 'vitest';
import {
  runWithFallback,
  makeSyntheticRunResult,
  TRANSPORT_FAILURES,
  type UnavailableMap,
} from '../../packages/core/src/escalation/fallback.js';
import type { Provider, RunResult, AgentType } from '../../packages/core/src/types.js';

function mockProvider(name: string, run: () => Promise<RunResult>): Provider {
  return { name, config: { type: 'codex', model: 'mock' } as never, run };
}

function okResult(name: string): RunResult {
  return {
    status: 'ok',
    output: `from ${name}`,
    outputIsDiagnostic: false,
    turns: 1,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUSD: 0.01, savedCostUSD: 0 },
    filesRead: [],
    filesWritten: [],
    toolCalls: [],
    escalationLog: [],
  } as unknown as RunResult;
}

function failResult(status: 'api_error' | 'network_error' | 'timeout'): RunResult {
  return { ...okResult('failed'), status, output: '' };
}

const isTransportFailure = (r: RunResult) => TRANSPORT_FAILURES.has(r.status);
const makeSynthetic = (assigned: AgentType) => makeSyntheticRunResult(assigned, 'all_tiers_unavailable');

describe('runWithFallback — happy path', () => {
  it('returns success with no fallback when assigned tier succeeds', async () => {
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => okResult('standard'));
    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : undefined),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      call: (p) => p.run('test', {}),
    });
    expect(result.fallbackFired).toBe(false);
    expect(result.bothUnavailable).toBe(false);
    expect(result.usedTier).toBe('standard');
    expect(map.size).toBe(0);
  });
});

describe('runWithFallback — transport failure substitutes alt', () => {
  it.each(['api_error', 'network_error', 'timeout'] as const)(
    'falls back on %s with reason=transport_failure',
    async (failStatus) => {
      const map: UnavailableMap = new Map();
      const standard = mockProvider('standard', async () => failResult(failStatus));
      const complex = mockProvider('complex', async () => okResult('complex'));
      const result = await runWithFallback<RunResult>({
        assigned: 'standard',
        providerFor: (t) => (t === 'standard' ? standard : complex),
        unavailableTiers: map,
        isTransportFailure,
        getStatus: (r) => r.status,
        makeSyntheticFailure: makeSynthetic,
        call: (p) => p.run('test', {}),
      });
      expect(result.fallbackFired).toBe(true);
      expect(result.fallbackReason).toBe('transport_failure');
      expect(result.usedTier).toBe('complex');
      expect(result.bothUnavailable).toBe(false);
      expect(result.fallbackTriggeringStatus).toBe(failStatus);
      expect(map.get('standard')).toBe('transport_failure');
    },
  );
});

describe('runWithFallback — non-transport failures do NOT trigger fallback', () => {
  it.each(['incomplete', 'cost_exceeded', 'brief_too_vague', 'unavailable'] as const)(
    'returns %s as-is, no fallback',
    async (status) => {
      const map: UnavailableMap = new Map();
      const r: RunResult = { ...okResult('s'), status };
      const standard = mockProvider('standard', async () => r);
      const complex = mockProvider('complex', async () => okResult('complex'));
      const result = await runWithFallback<RunResult>({
        assigned: 'standard',
        providerFor: (t) => (t === 'standard' ? standard : complex),
        unavailableTiers: map,
        isTransportFailure,
        makeSyntheticFailure: makeSynthetic,
        call: (p) => p.run('test', {}),
      });
      expect(result.fallbackFired).toBe(false);
      expect(result.usedTier).toBe('standard');
      expect(map.size).toBe(0);
    },
  );
});

describe('runWithFallback — sticky behavior', () => {
  it('pre-marked unavailable tier auto-substitutes WITHOUT calling provider', async () => {
    const map: UnavailableMap = new Map([['standard', 'transport_failure']]);
    const standardCalls = vi.fn(async () => okResult('standard'));
    const complex = mockProvider('complex', async () => okResult('complex'));
    const standard = mockProvider('standard', standardCalls);
    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      call: (p) => p.run('test', {}),
    });
    expect(standardCalls).not.toHaveBeenCalled();
    expect(result.usedTier).toBe('complex');
    expect(result.fallbackReason).toBe('transport_failure');
  });

  it('first-write-wins: re-marking does not overwrite existing reason', async () => {
    const map: UnavailableMap = new Map([['standard', 'not_configured']]);
    const standard = mockProvider('standard', async () => failResult('api_error'));
    const complex = mockProvider('complex', async () => okResult('complex'));
    await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      call: (p) => p.run('test', {}),
    });
    expect(map.get('standard')).toBe('not_configured');
  });
});

describe('runWithFallback — not_configured fallback', () => {
  it('substitutes when providerFor returns undefined', async () => {
    const map: UnavailableMap = new Map();
    const complex = mockProvider('complex', async () => okResult('complex'));
    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? undefined : complex),
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      call: (p) => p.run('test', {}),
    });
    expect(result.fallbackFired).toBe(true);
    expect(result.fallbackReason).toBe('not_configured');
    expect(result.usedTier).toBe('complex');
    expect(map.get('standard')).toBe('not_configured');
  });
});

describe('runWithFallback — both unavailable up-front', () => {
  it('returns synthetic failure when both providers undefined; no calls made', async () => {
    const map: UnavailableMap = new Map();
    const callSpy = vi.fn();
    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: () => undefined,
      unavailableTiers: map,
      isTransportFailure,
      makeSyntheticFailure: makeSynthetic,
      call: callSpy,
    });
    expect(callSpy).not.toHaveBeenCalled();
    expect(result.bothUnavailable).toBe(true);
    expect(result.usedTier).toBe('none');
    expect(result.result.status).toBe('unavailable');
    expect(map.get('standard')).toBe('not_configured');
    expect(map.get('complex')).toBe('not_configured');
  });
});

describe('runWithFallback — both unavailable mid-call', () => {
  it('assigned fails, alt also fails — returns alt failure with both triggering statuses preserved', async () => {
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => failResult('api_error'));
    const complex = mockProvider('complex', async () => failResult('network_error'));
    const result = await runWithFallback<RunResult>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure,
      getStatus: (r) => r.status,
      makeSyntheticFailure: makeSynthetic,
      call: (p) => p.run('test', {}),
    });
    expect(result.bothUnavailable).toBe(true);
    expect(result.fallbackFired).toBe(true);
    expect(result.fallbackTriggeringStatus).toBe('api_error');
    expect(result.unavailableTriggeringStatus).toBe('network_error');
    expect(result.usedTier).toBe('complex');
    expect(result.result.status).toBe('network_error');
    expect(map.get('standard')).toBe('transport_failure');
    expect(map.get('complex')).toBe('transport_failure');
  });
});

describe('runWithFallback — generic with custom T', () => {
  interface FakeReview { status: 'ok' | 'api_error' | 'changes_required'; finding?: string; }

  it('works with caller-supplied T type', async () => {
    const map: UnavailableMap = new Map();
    const standard = mockProvider('standard', async () => ({ status: 'api_error' }) as unknown as RunResult);
    const complex = mockProvider('complex', async () => ({ status: 'ok', finding: 'looks good' }) as unknown as RunResult);
    const result = await runWithFallback<FakeReview>({
      assigned: 'standard',
      providerFor: (t) => (t === 'standard' ? standard : complex),
      unavailableTiers: map,
      isTransportFailure: (r) => r.status === 'api_error',
      makeSyntheticFailure: () => ({ status: 'api_error' }),
      call: async (p) => (await p.run('', {})) as unknown as FakeReview,
    });
    expect(result.fallbackFired).toBe(true);
    expect(result.usedTier).toBe('complex');
    expect(result.result.finding).toBe('looks good');
    expect(map.get('standard')).toBe('transport_failure');
  });
});
