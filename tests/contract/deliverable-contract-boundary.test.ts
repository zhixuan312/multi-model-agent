import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalContractDigest } from '@zhixuan92/multi-model-agent-core';
import { boot } from './fixtures/harness.js';
import { mockProvider } from './fixtures/mock-providers.js';

/** A contract whose `contractApproval.contractDigest` does not match its own content. */
const MISMATCHED_CONTRACT = {
  state: 'approved',
  kind: 'report',
  audience: 'board',
  artifacts: [{ root: 'workspaceRoot', path: 'report.md' }],
  acceptance: [{ id: 'review', criterion: 'Reviewed', method: 'human', references: [{ kind: 'none', reason: 'Owner judgement' }] }],
  disposition: 'deliver-file',
  contractApproval: { contractDigest: 'wrong', approvedBy: 'Owner', approvedAt: '2026-08-08T00:00:00.000Z' },
};

const REQUEST = { type: 'plan', prompt: 'plan', target: { inline: 'spec' }, deliverable: MISMATCHED_CONTRACT };

/** A `pr` contract that is entirely well-formed — correct digest included — so the only thing
 *  that can reject it is the git-repository feasibility check. */
function approvedPrContract() {
  const proposed = {
    kind: 'code change',
    audience: 'maintainers',
    artifacts: [{ root: 'workspaceRoot' as const, path: 'src/thing.ts' }],
    acceptance: [{ id: 'review', criterion: 'Reviewed', method: 'human' as const, references: [{ kind: 'none' as const, reason: 'Owner judgement' }] }],
    disposition: 'pr' as const,
  };
  return {
    state: 'approved' as const,
    ...proposed,
    contractApproval: {
      contractDigest: canonicalContractDigest(proposed),
      approvedBy: 'Owner',
      approvedAt: '2026-08-08T00:00:00.000Z',
    },
  };
}

describe('approved Deliverable Contract boundary', () => {
  it('rejects a digest-mismatched supplied contract before opening a provider on REST and MCP', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const response = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}`, 'X-MMA-Client': 'claude-code' }, body: JSON.stringify(REQUEST) });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('invalid_request');

      // The MCP half. The title has always said "REST and MCP", and only REST was exercised —
      // `mcp-adapter.ts` calls the same `validateDeliverableContractBoundary`, but deleting that
      // call left this test green, because nothing here ever reached the second transport. Two
      // transports enforcing one rule is exactly the shape that drifts.
      const client = new Client({ name: 'contract', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
      }));
      try {
        const result = await client.callTool({ name: 'mma_run', arguments: { cwd: process.cwd(), mode: 'handle', request: REQUEST } });
        expect((result as { isError?: boolean }).isError, 'MCP admitted a digest-mismatched contract').toBe(true);
        const body = JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as { error?: { code?: string } };
        expect(body.error?.code).toBe('invalid_request');
      } finally { await client.close(); }
    } finally { await h.close(); }
  });

  /**
   * The check that is unique to the boundary validator, on both transports.
   *
   * A digest mismatch is caught one layer earlier, by `approvedContractSchema` — which is why
   * deleting `validateDeliverableContractBoundary` from the MCP adapter left the case above
   * green. What only the boundary validator does is the FILESYSTEM-dependent half
   * (`deliverable-contract.ts` keeps those out of core deliberately): INV-3, that a `pr` or
   * `commit-in-place` disposition requires the workspace root to be a git repository.
   *
   * So this drives a well-formed, correctly-digested `pr` contract against a cwd that is not a
   * git repo. Nothing else in the request is wrong; only the validator can reject it.
   */
  it('rejects a pr disposition outside a git repository, on REST and MCP', async () => {
    const nonGitCwd = realpathSync(mkdtempSync(join(tmpdir(), 'mma-nongit-')));
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: nonGitCwd });
    try {
      const contract = approvedPrContract();
      const request = { type: 'plan', prompt: 'plan', target: { inline: 'spec' }, deliverable: contract };

      const rest = await fetch(`${h.baseUrl}/execution?cwd=${encodeURIComponent(nonGitCwd)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}`, 'X-MMA-Client': 'claude-code' },
        body: JSON.stringify(request),
      });
      expect(rest.status).toBe(400);
      const restBody = await rest.json() as { error: { code: string; details?: { fieldErrors?: Record<string, string[]> } } };
      expect(restBody.error.code).toBe('invalid_request');
      expect(JSON.stringify(restBody.error.details)).toContain('git repository');

      const client = new Client({ name: 'contract', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${h.token}` } },
      }));
      try {
        const result = await client.callTool({ name: 'mma_run', arguments: { cwd: nonGitCwd, mode: 'handle', request } });
        expect((result as { isError?: boolean }).isError, 'MCP admitted a pr contract outside git').toBe(true);
        expect((result as { content: Array<{ text: string }> }).content[0]!.text).toContain('git repository');
      } finally { await client.close(); }
    } finally {
      await h.close();
      rmSync(nonGitCwd, { recursive: true, force: true });
    }
  });
});