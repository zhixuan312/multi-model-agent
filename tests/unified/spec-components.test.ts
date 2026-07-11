import { describe, expect, it } from 'vitest';
import {
  SPEC_COMPONENTS,
  resolveComponents,
  type SpecComponent,
} from '../../packages/core/src/unified/spec-components.js';

describe('spec component helpers', () => {
  it('exports the canonical component labels in Forge order', () => {
    expect(SPEC_COMPONENTS).toEqual([
      'Context',
      'Problem',
      'Goals & Requirements',
      'Alternatives',
      'Technical Design',
      'Testing Plan',
      'Risks & Mitigations',
      'User Stories & Tasks',
    ]);
  });

  it('returns all components when input is undefined', () => {
    expect(resolveComponents(undefined)).toEqual(SPEC_COMPONENTS);
  });

  it('returns all components when input is an empty array', () => {
    expect(resolveComponents([])).toEqual(SPEC_COMPONENTS);
  });

  it('deduplicates and reorders non-empty input into canonical order', () => {
    const requested: SpecComponent[] = [
      'Technical Design',
      'Context',
      'Technical Design',
      'Problem',
    ];

    expect(resolveComponents(requested)).toEqual([
      'Context',
      'Problem',
      'Technical Design',
    ]);
  });

  it('returns a fresh array so callers cannot mutate SPEC_COMPONENTS by reference', () => {
    const resolved = resolveComponents(undefined);
    resolved.pop();
    expect(SPEC_COMPONENTS).toHaveLength(8);
    expect(resolveComponents(undefined)).toEqual(SPEC_COMPONENTS);
  });
});
