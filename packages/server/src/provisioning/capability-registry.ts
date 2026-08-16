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
type SkillPathStrategy = 'standard' | 'bespoke' | 'none';

/** The shape and location of a client's MCP registration entry. */
export type McpConfigFormat = 'json' | 'toml' | 'plugin-json' | 'stdio-json';

/**
 * The primary-source evidence backing a client's writer.
 *
 * Present for exactly the clients `docs/verification/
 * mcp-client-registration-profiles.md` covers and marks ready. The five writers
 * that predate that artifact (claude-code, claude-desktop, codex, antigravity,
 * cursor) carry no profile -- their absence records that they were not verified
 * through this gate, and pretending otherwise by back-filling a profile nobody
 * researched would make the gate a decoration.
 *
 * The rule is enforced from the artifact rather than from a list in code: see
 * `tests/contract/clients/gated-registration-writers.test.ts`, which reads that
 * document and requires the capability row and the writer registry to agree with
 * every client it covers.
 */
interface RegistrationProfile {
  /** The exact vendor-owned source URL this profile was verified against.
   *  Must appear verbatim in the evidence artifact. */
  verifiedBy: string;
  /** The verified user-level registration path, human-readable (writers resolve
   *  their own actual path; this is the evidence record, not executable). */
  path: string;
  /** How MMA recognises its own previously-written entry in this client's file. */
  ownershipRecognizer: string;
  /** The client's own connect-time credential substitution mechanism. Never a
   *  static token. */
  dynamicCredentialMechanism: string;
}

export interface ClientCapability {
  id: ClientId;
  skillPathStrategy: SkillPathStrategy;
  /** EXACTLY ONE root, or null. Required to be null when -- and only when --
   *  skillPathStrategy is 'none'. */
  skillRoot: string | null;
  /** Plural on purpose: a client may have OS-specific registration locations
   *  (Claude Desktop's macOS vs Windows paths). Unrelated to skill roots.
   *
   *  EMPTY means "no verified path, so no writer may target this client".
   *  Emptiness is the uniform, checkable signal -- never leave a half-trusted
   *  path here.
   *
   *  TWO rows are empty, for opposite reasons, and each row states its own:
   *  `vscode` never had a derivable home-level path to begin with, and
   *  `antigravity` had one that the vendor retired. See
   *  docs/verification/mcp-client-registration-profiles.md. */
  mcpConfigPaths: readonly string[];
  mcpConfigFormat: McpConfigFormat;
  /** The top-level key a client's registration file nests its MCP servers under.
   *  Defaults to `mcpServers` when omitted -- every client but opencode uses that
   *  default; opencode verified its own servers live under a top-level `mcp` key
   *  instead. Read by `registration-writer.ts` so a differently-keyed client
   *  never needs a second, forked install path. */
  mcpTopLevelKey?: string;
  /** Present for exactly the clients the evidence artifact covers and marks
   *  ready. `vscode` stays without one -- it remains BLOCKED. See the
   *  {@link RegistrationProfile} doc for why the older writers carry none. */
  registrationProfile?: RegistrationProfile;
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
    // Corrected, not guessed: Google folded Gemini CLI into Antigravity CLI and
    // moved the global skills root here. `~/.gemini/skills` — what this row said
    // before — no longer exists on any install.
    skillRoot: '~/.gemini/antigravity-cli/skills',
    // BLOCKED. Empty is this registry's uniform signal for "no verified path, so
    // no writer may target this client" — the same state VS Code is in, reached
    // for the opposite reason: VS Code never published a path, Antigravity
    // retired the one it had. The vendor replaced a home-level config MMA writes
    // into with a plugin bundle its own CLI installs, so there is no path to
    // re-point at. Google is an Agent Plugins Core Maintainer, so the expected
    // resolution is the `agent-plugin` package serving this client with no
    // writer at all. See docs/verification/mcp-client-registration-profiles.md.
    mcpConfigPaths: [],
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
    // Blocked, and not pending: the search concluded. Microsoft documents the
    // workspace path but reaches the user-level file only through the "MCP: Open
    // User Configuration" command, and profiles are relocatable, so no stable
    // home-level path exists to derive. Empty here is the whole signal -- no
    // writer may target this client while it stays empty.
    mcpConfigPaths: [],
    mcpConfigFormat: 'json',
  },
  {
    id: 'opencode',
    skillPathStrategy: 'standard',
    skillRoot: '~/.agents/skills',
    // Verified against opencode.ai's own docs (see docs/verification/
    // mcp-client-registration-profiles.md). Servers live under the `mcp` key as
    // { type: 'remote', url, headers, enabled }; headers substitute secrets with
    // the brace form {env:VAR} -- NOT ${env:VAR}.
    mcpConfigPaths: ['~/.config/opencode/opencode.json'],
    mcpConfigFormat: 'json',
    mcpTopLevelKey: 'mcp',
    registrationProfile: {
      verifiedBy: 'https://opencode.ai/docs/mcp-servers/',
      path: '~/.config/opencode/opencode.json',
      ownershipRecognizer: 'The top-level `mcp` map is keyed by server name; MMA owns and mutates only its own `mma` key, leaving every sibling entry untouched.',
      dynamicCredentialMechanism: 'Header substitution with the brace-only form {env:VAR_NAME} (documented on the Context7 example) -- NOT the ${env:VAR} form other clients use.',
    },
  },
  {
    id: 'windsurf',
    skillPathStrategy: 'none',
    skillRoot: null,
    // Verified against the vendor's own docs, which docs.windsurf.com now
    // 307-redirects to (Cognition acquired Windsurf). Servers live under
    // `mcpServers`; a remote entry uses `serverUrl` (not `url`) plus `headers`.
    // Its ${file:/path} substitution is the cleanest credential mechanism of any
    // client here -- the entry can point straight at ~/.mma/auth-token, so the
    // token is read at connect time with no static secret and no helper script.
    mcpConfigPaths: ['~/.codeium/windsurf/mcp_config.json'],
    mcpConfigFormat: 'json',
    registrationProfile: {
      verifiedBy: 'https://docs.devin.ai/desktop/cascade/mcp',
      path: '~/.codeium/windsurf/mcp_config.json',
      ownershipRecognizer: 'The `mcpServers` map is keyed by server name; MMA owns and mutates only its own `mma` key, leaving every sibling entry untouched.',
      dynamicCredentialMechanism: '${file:~/.mma/auth-token} resolved at connect time from the token file MMA already owns -- preferred over ${env:VAR}, which would require the user to export a variable before launching Windsurf.',
    },
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
