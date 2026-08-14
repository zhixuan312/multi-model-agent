import { describe, expect, it } from 'vitest';
import {
  DuplicateTargetAdapterError,
  isInitiativeError,
  registerTargetAdapter,
} from '../../packages/core/src/initiative-record/index.js';

describe('SPEC-007 target adapter duplicate error', () => {
  it('uses the documented conflict-shaped typed error', () => {
    const adapter = {
      target_type: 'target-adapter-error-contract-test',
      validate: () => ({ valid: true, detail: 'ok' }),
    };
    registerTargetAdapter(adapter);

    let thrown: unknown;
    try {
      registerTargetAdapter(adapter);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateTargetAdapterError);
    expect(thrown).toMatchObject({
      code: 'duplicate_target_adapter',
      target_type: adapter.target_type,
    });
    expect(isInitiativeError(thrown)).toBe(true);
  });
});
