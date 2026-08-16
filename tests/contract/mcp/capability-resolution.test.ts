import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import {
  MCP_CAPABILITIES_WITH_APP,
  MCP_CAPABILITIES_TOOLS_ONLY,
  resolveMcpCapabilities,
} from '../../../packages/server/src/mcp/tool-surface.js';

describe('contract: MCP capability resolution', () => {
  it('resolves the full set only when the artifact is available', () => {
    expect(resolveMcpCapabilities(true)).toEqual({
      tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': {} },
    });
    expect(resolveMcpCapabilities(true)).toBe(MCP_CAPABILITIES_WITH_APP);
  });

  it('resolves the pre-Flow-2 tools-only set, byte-identical to today, when unavailable', () => {
    expect(resolveMcpCapabilities(false)).toEqual({ tools: {}, extensions: {} });
    expect(resolveMcpCapabilities(false)).toBe(MCP_CAPABILITIES_TOOLS_ONLY);
    expect(resolveMcpCapabilities(false)).not.toHaveProperty('resources');
  });

  it('http/server.ts resolves capabilities exactly once, before the /mcp route is registered', async () => {
    const source = await readFile('packages/server/src/http/server.ts', 'utf8');
    const calls = source.match(/resolveMcpCapabilities\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const resolveIndex = source.indexOf('resolveMcpCapabilities(');
    const routeIndex = source.indexOf("router.register('POST', '/mcp'");
    expect(resolveIndex).toBeGreaterThan(-1);
    expect(routeIndex).toBeGreaterThan(resolveIndex);
    expect(source).toMatch(/const mcpDeps[^;]*capabilities/s);
  });

  // The single home for "the adapter resolves capabilities through one deps-carried binding".
  // This assertion also stood in `discover.test.ts` (with the import check below) and part of it
  // in `sdk-governance.test.ts` — one source-text fact written in three files, two of which are
  // about something else, so tightening the pattern meant finding all three.
  it('mcp-adapter.ts reads deps.capabilities rather than importing or inlining a capabilities constant', async () => {
    const source = await readFile('packages/server/src/mcp/mcp-adapter.ts', 'utf8');
    expect(source).not.toMatch(/capabilities:\s*\{\s*tools:/);
    expect(source.match(/deps\.capabilities/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/import[\s\S]*MCP_CAPABILITIES[\s\S]*from ['"]\.\/tool-surface\.js['"]/);
  });
});