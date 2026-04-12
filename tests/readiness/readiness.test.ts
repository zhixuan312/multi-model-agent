import { describe, it, expect } from 'vitest';
import {
  hasScopePillar,
  hasInputsPillar,
  hasDoneConditionPillar,
  hasOutputContractPillar,
} from '@zhixuan92/multi-model-agent-core/readiness/readiness';

describe('Layer 1: scope', () => {
  it('passes with a file path', () => {
    expect(hasScopePillar('Update src/auth/middleware.ts to use JWT.')).toBe(true);
  });
  it('passes with a directory', () => {
    expect(hasScopePillar('Changes under packages/core/src/runners/.')).toBe(true);
  });
  it('passes with a glob', () => {
    expect(hasScopePillar('Rename every tests/**/*.test.ts fixture.')).toBe(true);
  });
  it('passes with a backtick-wrapped module', () => {
    expect(hasScopePillar('Refactor `auth-middleware` to use JWT.')).toBe(true);
  });
  it('passes with explicit out-of-bounds', () => {
    expect(hasScopePillar('Fix the auth bug. Do not modify the test fixtures.')).toBe(true);
  });
  it('fails on a bare topic noun', () => {
    expect(hasScopePillar('Fix the auth stuff.')).toBe(false);
  });
  it('fails on empty', () => {
    expect(hasScopePillar('')).toBe(false);
  });
});

describe('Layer 1: inputs', () => {
  it('passes with a file reference', () => {
    expect(hasInputsPillar('Follow the pattern in users.ts.')).toBe(true);
  });
  it('passes with a fenced code block', () => {
    expect(hasInputsPillar('Transform:\n```json\n{"a":1}\n```\ninto YAML.')).toBe(true);
  });
  it('fails with no readable source', () => {
    expect(hasInputsPillar('Use the right config.')).toBe(false);
  });
});

describe('Layer 1: done condition', () => {
  it('passes with "tsc passes"', () => {
    expect(hasDoneConditionPillar('Done when tsc passes.')).toBe(true);
  });
  it('passes with a test file reference', () => {
    expect(hasDoneConditionPillar('Done when tests/auth/new.test.ts passes.')).toBe(true);
  });
  it('passes with expectedCoverage reference', () => {
    expect(hasDoneConditionPillar('Done when expectedCoverage.requiredMarkers present.')).toBe(true);
  });
  it('fails on "it works"', () => {
    expect(hasDoneConditionPillar('Just make it work.')).toBe(false);
  });
});

describe('Layer 1: output contract', () => {
  it('passes by default (structured report)', () => {
    expect(hasOutputContractPillar('anything', false)).toBe(true);
    expect(hasOutputContractPillar('anything', undefined)).toBe(true);
  });
  it('passes with explicit format when structured report disabled', () => {
    expect(hasOutputContractPillar('Return JSON with fields x, y.', true)).toBe(true);
  });
  it('fails when structured report disabled and no format', () => {
    expect(hasOutputContractPillar('Fix the bug.', true)).toBe(false);
  });
});
