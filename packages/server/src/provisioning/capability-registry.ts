// The frozen client capability registry — one row per ClientId, in CLIENT_IDS
// order. This table IS the extension point: adding a client is adding a row.
// Every row's skillRoot is null exactly when skillPathStrategy is 'none', and
// non-null otherwise (AC-4.6). ~/.agents/skills is deliberately shared by
// cursor, vscode, and opencode -- those clients all read it, and the paths
// are dictated by each client rather than chosen by MMA (FR-9a reference
// counting exists precisely for this row group).
import { CLIENT_IDS, type ClientId } from '@zhixuan92/multi-model-agent-core';

/** How a client's skills are laid out on disk. 'none' means the client has
 *  no Agent Skills mechanism at all -- registration alone is a complete,
 *  successful install for it (FR-8). */
export type SkillPathStrategy = 'standard' | 'bespoke' | 'none';

/** The shape and location of a client's MCP registration entry. */
export type McpConfigFormat = 'json' | 'toml' | 'plugin-json' | 'stdio-json';

export interface ClientCapability {
  id: ClientId;
  skillPathStrategy: SkillPathStrategy;
  /** EXACTLY ONE root, or null. Required to be null when -- and only when --
   *  skillPathStrategy is 'none'. */
  skillRoot: string | null;
  /** Plural on purpose: a client may have OS-specific registration locations
   *  (Claude Desktop's macOS vs Windows paths). Unrelated to skill roots.
   *
   *  EMPTY means "gated": the path is not yet confirmed against the vendor's
   *  own documentation, so no writer may target this client. That currently
   *  covers vscode, opencode, and windsurf, whose writers are blocked in
   *  Task I-6 behind the primary-source artifact from Task I-1. Emptiness is
   *  the uniform, checkable signal -- never leave a half-trusted path here. */
  mcpConfigPaths: readonly string[];
  mcpConfigFormat: McpConfigFormat;
}

/** The frozen capability registry -- exactly one row per ClientId, in
 *  CLIENT_IDS order. See the spec's Data model table; values are used
 *  verbatim. */
export const CLIENT_CAPABILITIES: readonly ClientCapability[] = [
  {
    id: 'claude-code',
    skillPathStrategy: 'standard',
    skillRoot: '~/.claude/skills',
    mcpConfigPaths: ['${CLAUDE_PLUGIN_ROOT}/.mcp.json'],
    mcpConfigFormat: 'plugin-json',
  },
  {
    id: 'claude-desktop',
    skillPathStrategy: 'none',
    skillRoot: null,
    mcpConfigPaths: [
      '~/Library/Application Support/Claude/claude_desktop_config.json',
      '%APPDATA%\\Claude\\claude_desktop_config.json',
    ],
    mcpConfigFormat: 'stdio-json',
  },
  {
    id: 'codex',
    skillPathStrategy: 'bespoke',
    skillRoot: '~/.codex/skills',
    mcpConfigPaths: ['~/.codex/config.toml'],
    mcpConfigFormat: 'toml',
  },
  {
    id: 'antigravity',
    skillPathStrategy: 'bespoke',
    skillRoot: '~/.gemini/skills',
    mcpConfigPaths: ['~/.gemini/config/mcp_config.json'],
    mcpConfigFormat: 'json',
  },
  {
    id: 'cursor',
    skillPathStrategy: 'standard',
    skillRoot: '~/.agents/skills',
    mcpConfigPaths: ['~/.cursor/mcp.json'],
    mcpConfigFormat: 'json',
  },
  {
    id: 'vscode',
    skillPathStrategy: 'standard',
    skillRoot: '~/.agents/skills',
    // Blocked: user-level registration path pending Task I-1 primary-source
    // verification. Writer implementation is gated in Task I-6.
    mcpConfigPaths: [],
    mcpConfigFormat: 'json',
  },
  {
    id: 'opencode',
    skillPathStrategy: 'standard',
    skillRoot: '~/.agents/skills',
    // Blocked: registration path pending Task I-1 primary-source
    // verification. Writer implementation is gated in Task I-6.
    mcpConfigPaths: [],
    mcpConfigFormat: 'json',
  },
  {
    id: 'windsurf',
    skillPathStrategy: 'none',
    skillRoot: null,
    // Blocked, exactly like vscode and opencode. The likely path is
    // ~/.codeium/windsurf/mcp_config.json, but that rests on secondary sources
    // only and never on Windsurf's own documentation, so it is NOT recorded
    // here: an empty mcpConfigPaths is the single, uniform signal that a row
    // awaits Task I-1 verification. Populating it would make this row look
    // ready to a writer while resting on exactly the evidence Task I-6's
    // dispatch precondition exists to reject.
    mcpConfigPaths: [],
    mcpConfigFormat: 'json',
  },
] as const;

if (CLIENT_CAPABILITIES.length !== CLIENT_IDS.length) {
  throw new Error(
    `capability registry has ${CLIENT_CAPABILITIES.length} rows but CLIENT_IDS has ${CLIENT_IDS.length} entries`,
  );
}
for (const [index, id] of CLIENT_IDS.entries()) {
  const row = CLIENT_CAPABILITIES[index];
  if (!row || row.id !== id) {
    throw new Error(`capability registry row ${index} must be '${id}' in CLIENT_IDS order`);
  }
  if ((row.skillRoot === null) !== (row.skillPathStrategy === 'none')) {
    throw new Error(`capability registry row '${id}' must have a null skillRoot iff skillPathStrategy is 'none'`);
  }
}
