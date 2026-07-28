# Claude Code plugin — build, distribute, publish

MMA ships as a Claude Code **plugin** so a user gets the skills *and* the MCP
server registration from one install. This document covers how the artifact is
produced, how the marketplace works, and how to publish it.

## What the plugin contains

| Component | Count | Invoked as |
|---|---|---|
| Skills | 16 | `/mma:audit`, `/mma:delegate`, `/mma:router`, … (also auto-matched by intent) |
| Commands | 2 | `/mma:flow`, `/mma:breakout` (explicit only) |
| MCP server | 1 | tools `mma_run`, `mma_task_get`, `mma_task_wait`, `mma_task_cancel` |

```
plugin/
├── .claude-plugin/plugin.json   ← manifest (ONLY this file lives here)
├── skills/<name>/SKILL.md       ← components must sit at the plugin ROOT
├── commands/<name>.md
├── scripts/mma-mcp-headers.sh   ← headersHelper (executable)
├── .mcp.json
└── README.md
```

## Component naming — the `mma-` prefix is stripped

Packaged skills are named `mma-audit`, `mma-delegate`, … because a standalone
`mma sync-skills` install writes them into a **flat** `~/.claude/skills/` shared
with every other tool: there, the prefix *is* the namespace.

A plugin already namespaces every component as `/<plugin>:<component>`, and the
directory name is the invocation name — so keeping the prefix would produce
`/mma:mma-audit`. The generator strips it:

| Packaged | Plugin component | Invoked as |
|---|---|---|
| `mma-audit` | `audit` | `/mma:audit` |
| `mma-execute-plan` | `execute-plan` | `/mma:execute-plan` |
| `mma-flow` | `flow` | `/mma:flow` |
| `multi-model-agent` (router) | `router` | `/mma:router` |

Three things move together so nothing goes stale:

1. **Directory name** — backs the invocation name.
2. **Frontmatter `name:`** — rewritten to the bare component name.
3. **Cross-references in prose** — `mma-investigate` becomes `mma:investigate`,
   `/mma-flow` becomes `/mma:flow`, and the family shorthand `mma-*` becomes
   `mma:*`, so a skill that tells Claude to use a sibling names it correctly.

The rewriter matches only exact packaged skill names, so unrelated text is
untouched: `mma serve`, `.mma/plans/`, `mma-parent`, and `mktemp -t mma-poll`
all survive verbatim. The product name `multi-model-agent` is never rewritten —
it appears throughout the prose as the project's name, not as a skill reference.

## It is generated, never hand-edited

`plugin/` is a build artifact produced from the packaged skills:

```bash
npm run build:plugin        # regenerates ./plugin from packages/server/src/skills/
```

The generator (`packages/server/src/plugin/build-plugin.ts`) reuses the same
skill root, name lists (`SUPPORTED_SKILLS` / `SUPPORTED_COMMANDS`) and
`@include _shared/…` inlining as every other client installer, so there is one
source of truth. Edit a skill under `packages/server/src/skills/`, re-run the
build, commit both.

A contract test (`tests/plugin/build-plugin.test.ts`) fails if the committed
`plugin/` drifts from what the generator produces — that guards the release
hazard of publishing a stale plugin after a skill edit.

Users can also build it for themselves:

```bash
mma plugin build                        # → ~/.mma/plugin
mma plugin build --out ./p --port 7337  # explicit
```

## Auth: no token is ever written into the artifact

The MCP entry uses `headersHelper`, not a static `headers` block:

```json
{ "mcpServers": { "mma": {
  "type": "http",
  "url": "http://127.0.0.1:7337/mcp",
  "headersHelper": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/mma-mcp-headers.sh"
} } }
```

The helper prints `{"Authorization": "Bearer <token>"}` on stdout, resolving the
token at **connection time** from `$MMA_AUTH_TOKEN` → `$MMA_TOKEN_FILE` →
`~/.mma/auth-token`. Consequences that matter:

- The published artifact holds no secret and is safe to commit, zip, and mirror.
- Rotating the token file is picked up on the next connection.
- Claude Code re-runs the helper automatically on `401`/`403` and retries once.
- With no token available the helper prints `{}` rather than failing, so the
  user sees an actionable auth error instead of a crash.

**This is why the generator does not pass `authToken` to `inlineIncludes`.** The
per-client installers *do* — they substitute the live token into skill text,
which is fine for a private `~/.claude/skills/` install but would leak a secret
into a distributable plugin. Plugin skills keep the runtime form
`${MMA_AUTH_TOKEN:-$(mma print-token)}`.

`${CLAUDE_PLUGIN_ROOT}` is quoted because the install path is version-scoped
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`) and may contain
spaces. It also changes on every plugin update, so never hardcode it.

## The marketplace

The repo root carries `.claude-plugin/marketplace.json`, which makes **this repo
itself a marketplace**:

```json
{ "name": "multi-model-agent",
  "owner": { "name": "…" },
  "plugins": [ { "name": "mma", "source": "./plugin", … } ] }
```

`source` is repo-relative and must resolve to a directory containing
`.claude-plugin/plugin.json`, or install fails with *"Plugin directory not found
at path"*. The contract test asserts this.

### Install paths for users

**From GitHub** (no review, available the moment the repo is public):

```bash
/plugin marketplace add zhixuan312/multi-model-agent
/plugin install mma@multi-model-agent
```

**From a local checkout** (development):

```bash
claude plugin marketplace add ./
claude plugin install mma@multi-model-agent
```

**Single session, no install:**

```bash
claude --plugin-dir ./plugin
```

### Updating published users

Users only receive an update when `version` in `plugin.json` changes — the
generator sets it from the server version, so a release bump propagates
automatically. Users refresh with `/plugin marketplace update`.

## Publishing to the community directory

Being installable from GitHub requires nothing but a public repo. Listing in
Claude Code's in-app directory is a separate, optional step:

1. `claude plugin validate ./plugin --strict` — must pass (the review pipeline
   runs the same check).
2. Submit via **Console** at `platform.claude.com/plugins/submit` (individual
   authors), or the **claude.ai** form at
   `claude.ai/admin-settings/directory/submissions/plugins/new` (requires a Team
   or Enterprise org with directory-management access).
3. Approved plugins are pinned to a commit SHA in the
   [`anthropics/claude-plugins-community`](https://github.com/anthropics/claude-plugins-community)
   catalog; CI bumps the pin as you push. The public catalog syncs nightly, so
   expect a delay between approval and installability as `@claude-community`.

`claude-plugins-official` is curated by Anthropic at their discretion — there is
no application process, and the submission form does not add plugins to it.

## Release checklist

1. `npm run build:plugin` — regenerate from current skills
2. `npm test` — the drift test proves `plugin/` matches the generator
3. `claude plugin validate ./plugin --strict`
4. Commit `plugin/` together with the skill changes that produced it
5. Push; users get it via `/plugin marketplace update`
