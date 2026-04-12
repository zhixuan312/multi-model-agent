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

import {
  detectOutsourcedDiscovery,
  detectBrittleLineAnchors,
  detectMixedEnvironmentActions,
  detectConcretePath,
  detectNamedCodeArtifact,
  detectReasonableLength,
} from '@zhixuan92/multi-model-agent-core/readiness/readiness';

describe('Layer 2: outsourced discovery', () => {
  it('flags "verify the exact imports"', () => {
    expect(detectOutsourcedDiscovery('Verify the exact imports.')).toBe(true);
  });
  it('flags "figure out the right path"', () => {
    expect(detectOutsourcedDiscovery('Figure out the right path.')).toBe(true);
  });
  it('does not flag concrete briefs', () => {
    expect(detectOutsourcedDiscovery('Update src/auth.ts line 42.')).toBe(false);
  });
});

describe('Layer 2: brittle line anchors', () => {
  it('flags bare line-range', () => {
    expect(detectBrittleLineAnchors('Extract lines 98–386 into a helper.')).toBe(true);
  });
  it('does not flag when semantic anchor present', () => {
    expect(detectBrittleLineAnchors('Refactor `computeWeeklyStats` (lines 98-140).')).toBe(false);
  });
});

describe('Layer 2: mixed environment actions', () => {
  it('flags commit/push', () => {
    expect(detectMixedEnvironmentActions('Update auth.ts, then commit and push.')).toBe(true);
  });
  it('does not flag plain implementation', () => {
    expect(detectMixedEnvironmentActions('Update src/auth.ts to use JWT.')).toBe(false);
  });
});

describe('Layer 3 hints', () => {
  it('detectConcretePath fires on file path', () => {
    expect(detectConcretePath('src/x.ts')).toBe(true);
  });
  it('detectNamedCodeArtifact fires on backtick identifier', () => {
    expect(detectNamedCodeArtifact('Refactor `computeWeeklyStats`.')).toBe(true);
  });
  it('detectReasonableLength fires on 100-char brief', () => {
    expect(detectReasonableLength('a'.repeat(100))).toBe(true);
  });
  it('detectReasonableLength rejects tiny brief', () => {
    expect(detectReasonableLength('fix it')).toBe(false);
  });
});

import { evaluateReadiness } from '@zhixuan92/multi-model-agent-core/readiness/readiness';
import type { TaskSpec } from '@zhixuan92/multi-model-agent-core';

const badBrief: TaskSpec = {
  prompt: 'Fix the thing.',
  agentType: 'standard',
};

const acceptableBrief: TaskSpec = {
  prompt:
    'Update the auth middleware in src/auth/middleware.ts to use JWT. ' +
    'Follow the pattern from users.ts. Verify the exact imports. ' +
    'Done when tsc passes and the existing auth tests still pass.',
  agentType: 'standard',
};

const idealBrief: TaskSpec = {
  prompt:
    'Update `src/auth/middleware.ts` to use `jsonwebtoken`. ' +
    'Import `verifyToken` from `src/auth/jwt-utils.ts`. ' +
    'Do not modify `src/auth/jwt-utils.ts`. Done when tsc passes.',
  agentType: 'standard',
};

describe('evaluateReadiness policy table', () => {
  it('normalize mode refuses a bad brief', () => {
    const r = evaluateReadiness(badBrief, 'normalize');
    expect(r.action).toBe('refuse');
    expect(r.missingPillars.length).toBeGreaterThan(0);
  });
  it('strict mode refuses a bad brief', () => {
    expect(evaluateReadiness(badBrief, 'strict').action).toBe('refuse');
  });
  it('warn mode never refuses', () => {
    const r = evaluateReadiness(badBrief, 'warn');
    expect(r.action).toBe('warn');
    expect(r.briefQualityWarnings.length).toBeGreaterThan(0);
  });
  it('off mode returns ignored', () => {
    expect(evaluateReadiness(badBrief, 'off').action).toBe('ignored');
  });
  it('normalize mode triggers normalization on Layer 2 hit', () => {
    const r = evaluateReadiness(acceptableBrief, 'normalize');
    expect(r.action).toBe('normalize');
    expect(r.layer2Warnings.length).toBeGreaterThan(0);
  });
  it('normalize mode passes ideal brief (no Layer 2 warnings)', () => {
    const r = evaluateReadiness(idealBrief, 'normalize');
    expect(r.action).toBe('warn');
    expect(r.layer2Warnings).toEqual([]);
  });
  it('defaults to normalize when policy is undefined', () => {
    expect(evaluateReadiness(acceptableBrief, undefined).action).toBe('normalize');
  });
});
