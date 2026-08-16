import { describe, expect, it } from 'vitest';
import {
  canonicalContractDigest,
  proposedContractSchema,
  SPEC_COMPONENTS,
  SPEC_COMPONENT_CATALOG,
} from '@zhixuan92/multi-model-agent-core';

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

describe('duplicate artifacts are detected after the SAME normalisation the digest applies', () => {
  // 'cafe' + U+0301 versus the precomposed U+00E9. macOS produces the first from a filename, a
  // human types the second — one contract can easily carry both.
  const NFD_ROOT = 'cafe\u0301';
  const NFC_ROOT = 'caf\u00e9';

  const contract = (artifacts: Array<{ root: string; path: string }>) => ({
    state: 'proposed' as const,
    kind: 'report',
    audience: 'team',
    disposition: 'deliver-file' as const,
    artifacts,
    acceptance: [{
      id: 'AC-1', criterion: 'reviewed', method: 'human' as const,
      references: [{ kind: 'none', reason: 'internal' }],
    }],
  });

  it('rejects two artifacts whose roots differ only in Unicode form', () => {
    // The invariant's own message says "after normalisation", but the key normalised only the
    // PATH. `canonicalContractDigest` normalises every string to NFC, so these two roots are one
    // root as far as the digest is concerned — the validator accepted a pair the digest treats as
    // the same artifact declared twice.
    const parsed = proposedContractSchema.safeParse(
      contract([{ root: NFD_ROOT, path: 'out.md' }, { root: NFC_ROOT, path: 'out.md' }]),
    );
    expect(parsed.success).toBe(false);
  });

  it('still accepts genuinely different roots', () => {
    // The normalisation must not collapse roots that really are distinct.
    const parsed = proposedContractSchema.safeParse(
      contract([{ root: 'docs', path: 'out.md' }, { root: 'reports', path: 'out.md' }]),
    );
    expect(parsed.success).toBe(true);
  });

  it('digests the two spellings identically — which is why the pair above is a duplicate', () => {
    const digestOf = (root: string) => canonicalContractDigest({
      kind: 'report', audience: 'team', disposition: 'deliver-file' as const,
      artifacts: [{ root, path: 'out.md' }],
      acceptance: [{
        id: 'AC-1', criterion: 'reviewed', method: 'human' as const,
        references: [{ kind: 'none', reason: 'internal' }],
      }],
    });
    expect(digestOf(NFD_ROOT)).toBe(digestOf(NFC_ROOT));
  });
});
