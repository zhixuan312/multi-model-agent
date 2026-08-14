import { describe, expect, it } from 'vitest';
import { registerTargetAdapter, resolveTargetAdapter } from '../../packages/core/src/initiative-record/index.js';

describe('SPEC-007 public target adapter registry', () => {
  it('registers and resolves only through the public opaque-key registry, and rejects a duplicate key', () => {
    const adapter = { target_type: 'contract-test-target', validate: () => ({ valid: true, detail: 'ok' }) };
    registerTargetAdapter(adapter);
    expect(resolveTargetAdapter('contract-test-target')).toBe(adapter);
    expect(() => registerTargetAdapter(adapter)).toThrow(/duplicate|conflict/i);
  });
});