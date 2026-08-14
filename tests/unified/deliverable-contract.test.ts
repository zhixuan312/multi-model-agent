import { describe, expect, it } from 'vitest';
import { canonicalContractDigest, SPEC_COMPONENTS, SPEC_COMPONENT_CATALOG } from '@zhixuan92/multi-model-agent-core';

const contract = {
  state: 'approved' as const,
  kind: 'quarterly finance report', audience: 'management', disposition: 'deliver-file' as const,
  artifacts: [{ root: 'workspaceRoot', path: 'out/report.pdf' }],
  acceptance: [{ id: 'totals', criterion: 'Totals reconcile', method: 'command' as const, references: [{ kind: 'dataset', locator: 'input.xlsx' }], command: { program: 'node', args: ['check.mjs'], timeoutMs: 600000 } }],
  contractApproval: { contractDigest: 'pending', approvedBy: 'A. Owner', approvedAt: '2026-08-08T00:00:00.000Z' },
};

describe('Deliverable Contract public API', () => {
  it('has stable identifiers, neutral labels, and a lifecycle-free digest', () => {
    expect(SPEC_COMPONENTS).toHaveLength(8);
    expect(SPEC_COMPONENT_CATALOG.find((item) => item.id === 'Technical Design')?.displayLabel).toBe('Approach, Method & Structure');
    const before = canonicalContractDigest(contract);
    const proposedVariant = { ...contract, state: 'proposed' as const };
    expect(canonicalContractDigest(proposedVariant)).toBe(before);
    expect(canonicalContractDigest({ ...contract, audience: 'board' })).not.toBe(before);
  });
});