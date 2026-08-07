# MCP client registration profiles — primary-source verification

Task I-1 evidence artifact. It is the **sole** unblocking input for the VS Code, Antigravity,
opencode, and Windsurf registration writers (Task I-6). No writer may guess a path or a schema; a
client whose record below is incomplete stays blocked.

**Rules this document is held to**

- Only **vendor-owned** documentation counts. Blogs, aggregators, and third-party integration
  guides are not evidence, however many of them agree.
- Verified facts and unresolved questions are stated separately. An unresolved item blocks its
  client rather than being filled in with a plausible value.
- No credential is ever recorded here, and no writer may persist a static token — every profile
  must name the client's own connect-time credential mechanism.

Retrieved **2026-08-04**.

---

## VS Code

**Status: BLOCKED — schema verified, user-level path not published.**

Sources (vendor-owned, `code.visualstudio.com`):
- https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- https://code.visualstudio.com/docs/agents/reference/mcp-configuration

### Verified

| Item | Value |
|---|---|
| Workspace-level path | `.vscode/mcp.json` |
| Top-level key | `servers` |
| HTTP entry fields | `type` (`"http"` or `"sse"`, required), `url` (required), `headers` (optional), `oauth` (optional) |
| Credential mechanism | Input variables, syntax `${input:<variable-id>}`, of kind `promptString`, `pickString`, or `command`. The docs explicitly say *"Avoid hardcoding sensitive information like API keys."* |
| MMA ownership recogniser | The `servers` map is keyed by server id, so MMA owns exactly the entry it names and must leave every sibling key untouched. |

### Unresolved — this is what blocks the writer

The **user-level (global) path is not published**. Both pages describe reaching it only through the
`MCP: Open User Configuration` command, and locate it as "the `mcp.json` file in your user profile
folder" without giving a per-platform path. VS Code user profiles are relocatable, so there is no
single stable path to derive.

Consequence: MMA cannot write VS Code's home-level registration, and the spec requires provisioning
to target home-level only. Two honest options, to be decided before I-6:

1. Keep `vscode` blocked and ship the other clients.
2. Support only the documented workspace path `.vscode/mcp.json`, behind the explicit project-scope
   opt-in flag the spec already defines — never as part of default home-level provisioning.

`${input:...}` also resolves interactively in the editor, which suits a human-configured server
better than a machine-written one; a `command`-kind input is the closest fit and needs its own
verification before use.

---

## opencode

**Status: VERIFIED — writer may proceed.**

Sources (vendor-owned, `opencode.ai`):
- https://opencode.ai/docs/mcp-servers/
- https://opencode.ai/docs/config/

### Verified

| Item | Value |
|---|---|
| User-level path | `~/.config/opencode/opencode.json` |
| Project-level path | `opencode.json` in the project root |
| Precedence | Project overrides global — config sources load global-then-project, later overriding earlier |
| Top-level key | `mcp` |
| Remote entry fields | `type: "remote"`, `url`, `headers` (optional), `enabled` (boolean), `oauth` (optional) |
| Credential mechanism | Variable substitution `{env:VAR_NAME}` inside `headers` — documented on the Context7 example, `"CONTEXT7_API_KEY": "{env:CONTEXT7_API_KEY}"`. Note the brace form is `{env:…}`, **not** `${env:…}`. |
| MMA ownership recogniser | The `mcp` map is keyed by server name; MMA owns only its own key and must preserve all others. |

MMA writes the **user-level** file only. `enabled` is an explicit field, so a disabled MMA entry is
representable without deleting the user's key.

---

## Windsurf

**Status: VERIFIED — writer may proceed.**

Source (vendor-owned): https://docs.devin.ai/desktop/cascade/mcp — `docs.windsurf.com` now issues a
307 redirect to `docs.devin.ai`, Cognition having acquired Windsurf, so this is the vendor's own
current documentation rather than a third party. The redirect itself is the provenance evidence.

### Verified

| Item | Value |
|---|---|
| Path | `~/.codeium/windsurf/mcp_config.json` — **user-level**, in the home directory. There is no project-level variant. |
| Top-level key | `mcpServers` |
| Remote entry fields | `serverUrl` (primary for remote HTTP; `url` also accepted), plus `headers` |
| Credential mechanism | `${env:VAR_NAME}` for environment variables and `${file:/path/to/file}` for file contents, with tilde expansion. Both work inside `command`, `args`, `env`, `serverUrl`, `url`, and `headers`. |
| MMA ownership recogniser | `mcpServers` is keyed by server name; MMA owns only its own key. |

**`${file:…}` is the best credential fit of any client profiled here.** It lets the registration
reference `~/.mma/auth-token` directly, so the token is read at connect time from the file MMA
already owns — no static secret in the config, and no helper script to ship. Prefer it over
`${env:…}`, which would require the user to export a variable before launching Windsurf.

Note that Windsurf has **no Agent Skills mechanism** (it uses `.windsurfrules`), which is why its
capability row is `skillPathStrategy: 'none'` with a `null` skillRoot. Registration alone is a
complete, successful provision for it.

---

## Antigravity

**Status: BLOCKED — the verified paths were retired by the vendor; replacements not verified for
MMA's registration shape.**

Sources (vendor-owned, `antigravity.google` / `developers.googleblog.com`):
- https://antigravity.google/docs/cli/plugins
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/

### Verified

| Item | Value |
|---|---|
| Prior MMA target (now dead) | `~/.gemini/config/mcp_config.json`, skills at `~/.gemini/skills` |
| Vendor transition | Gemini CLI folded into Antigravity CLI; Gemini CLI stopped serving Pro/Ultra requests **2026-06-18** |
| Current plugin root | `~/.gemini/antigravity-cli/plugins/<plugin_name>/` |
| Current global skills root | `~/.gemini/antigravity-cli/skills/` |
| Plugin manifest | `plugin.json` at the plugin ROOT, under the vendor's own schema `https://antigravity.google/schemas/v1/plugin.json` |
| MCP config | `mcp_config.json` at the plugin root — **not** the Agent Plugins `mcp.json` |
| Install mechanism | `agy plugin install /path/to/local/plugin` |

### Unresolved — this is what blocks the writer

The vendor moved from a **home-level config MMA writes into** to a **plugin bundle the CLI installs**.
Those are different integration models, not a changed path, so there is nothing to re-point the
existing writer at. The plugin route is also not reachable through this repo's Agent Plugins target:
Antigravity claims root `plugin.json` under its *own* `$schema`, colliding with Agent Plugins 1.0 at
the same filename, so one directory cannot satisfy both.

Google is an Agent Plugins Core Maintainer, so the likely resolution is that Antigravity converges on
the standard and this client is served by the `agent-plugin` package with no writer at all. Until
either that lands or `agy`'s manifest is verified against a real install, the row stays blocked —
which is also the honest description of its state before this section existed: the writer was aimed
at paths that no longer exist and nothing detected it.

---

## Summary

| Client | Path | Schema | Credential | Writer |
|---|---|---|---|---|
| VS Code | ❌ user-level unpublished | ✅ | ⚠️ `${input:…}` is interactive | **BLOCKED** |
| Antigravity | ❌ prior path retired by vendor | ❌ vendor schema, not AP 1.0 | — | **BLOCKED** |
| opencode | ✅ `~/.config/opencode/opencode.json` | ✅ `mcp` / `type: remote` | ✅ `{env:…}` | ready |
| Windsurf | ✅ `~/.codeium/windsurf/mcp_config.json` | ✅ `mcpServers` / `serverUrl` | ✅ `${file:…}` | ready |

Two of the four gated clients are unblocked. VS Code remains blocked on a path its vendor does not
publish. Antigravity is blocked on a vendor migration that replaced the integration model outright —
both are genuine external constraints, not unfinished searches, and precisely the case this artifact
exists to record rather than paper over.
