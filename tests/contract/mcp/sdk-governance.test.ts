import { readFile } from 'node:fs/promises';
import { MCP_CAPABILITIES, MCP_PROTOCOL_VERSION } from '../../../packages/server/src/mcp/tool-surface.js';

describe('contract: MCP SDK governance', () => {
  it('pins the SDK and records the mechanical protocol re-check immediately above MCP_CAPABILITIES', async () => {
    const packageJson = JSON.parse(await readFile('packages/server/package.json', 'utf8')) as { dependencies: Record<string, string> };
    const lock = await readFile('pnpm-lock.yaml', 'utf8');
    const surface = await readFile('packages/server/src/mcp/tool-surface.ts', 'utf8');
    expect(packageJson.dependencies['@modelcontextprotocol/sdk']).toBe('1.30.0');
    expect(lock).toMatch(/packages\/server:[\s\S]*'@modelcontextprotocol\/sdk':\s*\n\s*specifier: 1\.30\.0/);
    expect(surface).toMatch(/\/\*[\s\S]*SDK-PROTOCOL-RECHECK[\s\S]*1\.30\.0[\s\S]*2025-11-25[\s\S]*LATEST_PROTOCOL_VERSION[\s\S]*server\/discover[\s\S]*\*\/\s*\n\s*\/\*\*[\s\S]*\*\/\s*export const MCP_CAPABILITIES/);
    expect(surface).toMatch(/MCP_CAPABILITIES\s*=\s*\{\s*tools:\s*\{\},\s*extensions:\s*\{\},?\s*\}/);
  });

  // The plan's version of this asserted that the string "2026-07-28" appears nowhere in
  // tool-surface.ts. That is too blunt: the SDK-PROTOCOL-RECHECK comment must be able to
  // NAME the revision it is deliberately not advertising, and stripping the version from
  // that explanation would make the re-check trigger vaguer for no safety gain. What
  // actually matters is that the value MMA reports is the SDK's, and that no unimplemented
  // surface is declared — so assert those properties directly.
  it('advertises only the SDK-supported protocol version and no unimplemented capability', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(Object.keys(MCP_CAPABILITIES).sort()).toEqual(['extensions', 'tools']);
    expect(MCP_CAPABILITIES.extensions).toEqual({});
    expect(MCP_CAPABILITIES).not.toHaveProperty('resources');
    expect(MCP_CAPABILITIES.extensions).not.toHaveProperty('io.modelcontextprotocol/ui');
  });

  it('preserves the Claude Code HTTP plugin configuration unchanged', async () => {
    const plugin = await readFile('plugin/.mcp.json', 'utf8');
    expect(plugin).toContain('http://127.0.0.1:7337/mcp');
    expect(plugin).toContain('headersHelper');
    expect(plugin).not.toContain('mcp-remote');
  });
});
