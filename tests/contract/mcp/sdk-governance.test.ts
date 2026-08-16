import { readFile } from 'node:fs/promises';
import { MCP_PROTOCOL_VERSION } from '../../../packages/server/src/mcp/tool-surface.js';

describe('contract: MCP SDK governance', () => {
  it('pins the SDK and records the mechanical protocol re-check immediately above the capability exports', async () => {
    const packageJson = JSON.parse(await readFile('packages/server/package.json', 'utf8')) as { dependencies: Record<string, string> };
    const lock = await readFile('pnpm-lock.yaml', 'utf8');
    const surface = await readFile('packages/server/src/mcp/tool-surface.ts', 'utf8');
    expect(packageJson.dependencies['@modelcontextprotocol/sdk']).toBe('1.30.0');
    expect(lock).toMatch(/packages\/server:[\s\S]*'@modelcontextprotocol\/sdk':\s*\n\s*specifier: 1\.30\.0/);
    expect(surface).toMatch(/\/\*[\s\S]*SDK-PROTOCOL-RECHECK[\s\S]*1\.30\.0[\s\S]*2025-11-25[\s\S]*LATEST_PROTOCOL_VERSION[\s\S]*server\/discover[\s\S]*\*\/\s*\n\s*\/\*\*[\s\S]*\*\/\s*export const MCP_CAPABILITIES_WITH_APP/);
    expect(surface).toMatch(/MCP_CAPABILITIES_WITH_APP\s*=\s*\{[\s\S]*?extensions:\s*\{\s*'io\.modelcontextprotocol\/ui':\s*\{\}\s*\}/);
    expect(surface).toMatch(/MCP_CAPABILITIES_TOOLS_ONLY\s*=\s*\{\s*tools:\s*\{\},\s*extensions:\s*\{\},?\s*\}/);
  });

  // The protocol version is governance — it is pinned nowhere else, and it must move only when
  // the SDK re-check above is redone. What used to sit here alongside it was a second copy of
  // `resolveMcpCapabilities`'s behaviour, which `capability-resolution.test.ts` already asserts
  // more strictly (identity via `toBe`, not just structural equality). Two tests of one behaviour
  // in one directory means the weaker one can pass while the stronger one is the real contract.
  it('pins the advertised MCP protocol version', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-11-25');
  });

  it('preserves the Claude Code HTTP plugin configuration unchanged', async () => {
    const plugin = await readFile('plugin/.mcp.json', 'utf8');
    expect(plugin).toContain('http://127.0.0.1:7337/mcp');
    expect(plugin).toContain('headersHelper');
    expect(plugin).not.toContain('mcp-remote');
  });
});
