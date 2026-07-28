// MCP is a TRANSPORT that any client can speak — Claude Code, Codex CLI, an
// IDE, a script. Recording a flat `mcp` in telemetry would erase which one it
// was, defeating the purpose of the `client` column.
import { callerClientFromMeta } from '../../packages/server/src/mcp/mcp-adapter.js';

const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

describe('MCP caller attribution', () => {
  it('namespaces the real client when the protocol carries clientInfo', () => {
    expect(callerClientFromMeta({ [CLIENT_INFO]: { name: 'claude-code' } })).toBe('mcp:claude-code');
    expect(callerClientFromMeta({ [CLIENT_INFO]: { name: 'codex-cli' } })).toBe('mcp:codex-cli');
    // Display names normalize to the same slug shape the REST X-MMA-Client uses.
    expect(callerClientFromMeta({ [CLIENT_INFO]: { name: 'Codex CLI' } })).toBe('mcp:codex-cli');
    expect(callerClientFromMeta({ [CLIENT_INFO]: { name: 'My_Custom Script!' } })).toBe('mcp:my-custom-script');
  });

  it('degrades to the bare transport when clientInfo is absent or unusable', () => {
    // Claude Code currently negotiates 2025-06-18, which sends clientInfo only
    // at initialize — and this adapter is stateless per request.
    expect(callerClientFromMeta(undefined)).toBe('mcp');
    expect(callerClientFromMeta({})).toBe('mcp');
    expect(callerClientFromMeta({ [CLIENT_INFO]: {} })).toBe('mcp');
    expect(callerClientFromMeta({ [CLIENT_INFO]: { name: '' } })).toBe('mcp');
    expect(callerClientFromMeta({ [CLIENT_INFO]: { name: 42 } })).toBe('mcp');
    // A name of only separators slugs to empty — must not yield a bare "mcp:".
    expect(callerClientFromMeta({ [CLIENT_INFO]: { name: '!!!' } })).toBe('mcp');
  });

  it('every produced value satisfies the wire schema client regex', () => {
    // packages/core/src/events/wire-schema.ts STRICT_ID_REGEX — a value that
    // fails this would be dropped at telemetry validation.
    const STRICT_ID_REGEX = /^[A-Za-z0-9][-A-Za-z0-9_.:+/@]{0,119}$/;
    const names = ['claude-code', 'codex-cli', 'Cursor', 'some very long client name', '', '!!!'];
    for (const name of names) {
      const produced = callerClientFromMeta({ [CLIENT_INFO]: { name } });
      expect(STRICT_ID_REGEX.test(produced), `"${produced}" fails the wire client regex`).toBe(true);
    }
    expect(STRICT_ID_REGEX.test(callerClientFromMeta(undefined))).toBe(true);
  });
});
