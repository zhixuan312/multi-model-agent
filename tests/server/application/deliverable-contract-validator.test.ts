// packages/server/src/application/deliverable-contract-validator.ts — the filesystem-aware
// half of Deliverable Contract validation. Core (deliverable-contract.ts) is deliberately
// filesystem-free; this module is the only place INV-1 realpath containment and INV-3
// disposition feasibility are checked. Exercised directly (no HTTP boot) since the function
// is pure given a real directory tree.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateDeliverableContractBoundary } from '../../../packages/server/src/application/deliverable-contract-validator.js';
import type { ApprovedContract } from '@zhixuan92/multi-model-agent-core';
import { canonicalContractDigest } from '@zhixuan92/multi-model-agent-core';

function approvedContract(overrides: Partial<ApprovedContract> & Pick<ApprovedContract, 'artifacts' | 'disposition'>): ApprovedContract {
  const base = {
    kind: 'report',
    audience: 'board',
    acceptance: [{
      id: 'review', criterion: 'Reviewed', method: 'human' as const,
      references: [{ kind: 'none', reason: 'Owner judgement' }],
    }],
    ...overrides,
  };
  const digest = canonicalContractDigest(base as Pick<ApprovedContract, 'kind' | 'audience' | 'artifacts' | 'acceptance' | 'disposition'>);
  return {
    state: 'approved',
    ...base,
    contractApproval: { contractDigest: digest, approvedBy: 'Owner', approvedAt: '2026-08-08T00:00:00.000Z' },
  } as ApprovedContract;
}

describe('validateDeliverableContractBoundary', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'mma-deliverable-boundary-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('is valid when deliverable is absent — an unmanaged direct call', () => {
    const result = validateDeliverableContractBoundary(undefined, workspaceRoot);
    expect(result.ok).toBe(true);
  });

  it('accepts an artifact under root "workspaceRoot"', () => {
    const contract = approvedContract({
      artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
      disposition: 'deliver-file',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(true);
  });

  it('resolves a non-workspaceRoot root to the immediate child directory whose slug matches', () => {
    mkdirSync(join(workspaceRoot, 'sub-repo'));
    const contract = approvedContract({
      artifacts: [{ root: 'Sub Repo', path: 'out/report.md' }],
      disposition: 'deliver-file',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(true);
  });

  it('rejects an artifact root naming no immediate child directory', () => {
    const contract = approvedContract({
      artifacts: [{ root: 'no-such-repo', path: 'out/report.md' }],
      disposition: 'deliver-file',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/does not name an immediate child directory/);
    }
  });

  it('rejects an artifact root that is a slug collision between two immediate child directories', () => {
    mkdirSync(join(workspaceRoot, 'Sub Repo'));
    mkdirSync(join(workspaceRoot, 'sub_repo'));
    const contract = approvedContract({
      artifacts: [{ root: 'sub-repo', path: 'out/report.md' }],
      disposition: 'deliver-file',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/ambiguous/);
    }
  });

  it('rejects an artifact path that escapes its declared root via a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mma-deliverable-outside-'));
    try {
      mkdirSync(join(workspaceRoot, 'sub-repo'));
      symlinkSync(outside, join(workspaceRoot, 'sub-repo', 'escape'));
      const contract = approvedContract({
        artifacts: [{ root: 'sub-repo', path: 'escape/report.md' }],
        disposition: 'deliver-file',
      });
      const result = validateDeliverableContractBoundary(contract, workspaceRoot);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/escapes its declared root/);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects an artifact root whose matching child directory is itself a symlink escaping the workspace', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mma-deliverable-outside-'));
    try {
      symlinkSync(outside, join(workspaceRoot, 'sub-repo'));
      const contract = approvedContract({
        artifacts: [{ root: 'sub-repo', path: 'report.md' }],
        disposition: 'deliver-file',
      });
      const result = validateDeliverableContractBoundary(contract, workspaceRoot);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/escapes the workspace root/);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a CommandCheck.cwd that escapes the workspace root via a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mma-deliverable-outside-'));
    try {
      symlinkSync(outside, join(workspaceRoot, 'escape'));
      const contract = approvedContract({
        artifacts: [],
        disposition: 'deliver-file',
        acceptance: [{
          id: 'check', criterion: 'Totals reconcile', method: 'command',
          references: [{ kind: 'dataset', locator: 'input.xlsx' }],
          command: { program: 'node', args: ['check.mjs'], cwd: 'escape' },
        }],
      });
      const result = validateDeliverableContractBoundary(contract, workspaceRoot);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/command cwd escapes the workspace root/);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts a CommandCheck.cwd contained within the workspace root', () => {
    mkdirSync(join(workspaceRoot, 'scripts'));
    const contract = approvedContract({
      artifacts: [],
      disposition: 'deliver-file',
      acceptance: [{
        id: 'check', criterion: 'Totals reconcile', method: 'command',
        references: [{ kind: 'dataset', locator: 'input.xlsx' }],
        command: { program: 'node', args: ['check.mjs'], cwd: 'scripts' },
      }],
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(true);
  });

  it('rejects disposition "pr" outside a git repository', () => {
    const contract = approvedContract({
      artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
      disposition: 'pr',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.fieldErrors.deliverable?.[0]).toMatch(/requires the workspace root to be a git repository/);
    }
  });

  it('rejects disposition "commit-in-place" outside a git repository', () => {
    const contract = approvedContract({
      artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
      disposition: 'commit-in-place',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(false);
  });

  it('permits disposition "deliver-file" outside a git repository', () => {
    const contract = approvedContract({
      artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
      disposition: 'deliver-file',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(true);
  });

  it('permits disposition "pr" inside a git repository', () => {
    execFileSync('git', ['init', '-q'], { cwd: workspaceRoot });
    const contract = approvedContract({
      artifacts: [{ root: 'workspaceRoot', path: 'out/report.md' }],
      disposition: 'pr',
    });
    const result = validateDeliverableContractBoundary(contract, workspaceRoot);
    expect(result.ok).toBe(true);
  });
});
