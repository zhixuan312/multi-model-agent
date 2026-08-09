import { describe, expect, it } from 'vitest';
import { boot } from './fixtures/harness.js';
import { mockProvider } from './fixtures/mock-providers.js';

describe('approved Deliverable Contract boundary', () => {
  it('rejects a digest-mismatched supplied contract before opening a provider on REST and MCP', async () => {
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const response = await fetch(`${h.baseUrl}/task?cwd=${encodeURIComponent(process.cwd())}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}`, 'X-MMA-Client': 'claude-code' }, body: JSON.stringify({ type: 'plan', prompt: 'plan', target: { inline: 'spec' }, deliverable: { state: 'approved', kind: 'report', audience: 'board', artifacts: [{ root: 'workspaceRoot', path: 'report.md' }], acceptance: [{ id: 'review', criterion: 'Reviewed', method: 'human', references: [{ kind: 'none', reason: 'Owner judgement' }] }], disposition: 'deliver-file', contractApproval: { contractDigest: 'wrong', approvedBy: 'Owner', approvedAt: '2026-08-08T00:00:00.000Z' } } }) });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('invalid_request');
    } finally { await h.close(); }
  });
});