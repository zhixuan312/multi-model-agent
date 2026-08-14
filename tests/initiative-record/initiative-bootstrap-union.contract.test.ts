import { describe, expect, it } from 'vitest';
import { INITIATIVE_OPERATIONS, initiativeOperationRequestSchema } from '../../packages/core/src/initiative-record/index.js';
import { MCP_TOOLS } from '../../packages/server/src/mcp/tool-surface.js';
import { boot } from '../contract/fixtures/harness.js';
import { mockProvider } from '../contract/fixtures/mock-providers.js';

describe('initiative_bootstrap shared transport contract', () => {
  it('derives the HTTP and MCP surface from one operation-union member', async () => {
    expect(INITIATIVE_OPERATIONS).toContain('initiative_bootstrap');
    const members = initiativeOperationRequestSchema.options.filter((option) => option.safeParse({ operation: 'initiative_bootstrap', input: {}, expected_revision: 0, provenance: {} }).error?.issues.some((issue) => issue.path[0] === 'operation') === false);
    expect(members).toHaveLength(1);
    expect(MCP_TOOLS.map((tool) => tool.name)).toContain('mma_initiative_bootstrap');
    const h = await boot({ provider: mockProvider({ stage: 'ok' }), cwd: process.cwd() });
    try {
      const response = await fetch(`${h.baseUrl}/initiatives`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
        body: JSON.stringify({ operation: 'initiative_bootstrap', input: {}, expected_revision: 0, provenance: { actor_type: 'human', actor_id: 'u1', initiated_by: 'u1', authorized_by: 'u1', source: 'test' } }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    } finally {
      await h.close();
    }
  });
});