# MCP client registration profiles — primary-source verification

Task I-1 evidence artifact. It is the **sole** unblocking input for the VS Code, opencode, and
Windsurf registration writers (Task I-6). No writer may guess a path or a schema; a client whose
record below is incomplete stays blocked.

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

## Summary

| Client | Path | Schema | Credential | Writer |
|---|---|---|---|---|
| VS Code | ❌ user-level unpublished | ✅ | ⚠️ `${input:…}` is interactive | **BLOCKED** |
| opencode | ✅ `~/.config/opencode/opencode.json` | ✅ `mcp` / `type: remote` | ✅ `{env:…}` | ready |
| Windsurf | ✅ `~/.codeium/windsurf/mcp_config.json` | ✅ `mcpServers` / `serverUrl` | ✅ `${file:…}` | ready |

Two of the three gated clients are unblocked. VS Code remains blocked on a path its vendor does not
publish — a genuine external constraint, not an unfinished search, and precisely the case this
artifact exists to record rather than paper over.
