# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-04-10

Patch release: `@zhixuan92/multi-model-agent-mcp` to `0.1.2` and
`@zhixuan92/multi-model-agent-core` to `0.1.1`.

### Fixed

- **core, mcp**: `@openai/agents` and `openai` were declared as
  *optional* peer dependencies, so npm/npx never installed them
  alongside the published packages. End users running
  `npx @zhixuan92/multi-model-agent-mcp serve` saw the codex and
  openai-compatible runners crash on first dispatch with
  `Cannot find package 'openai'` / `Cannot find package
  '@openai/agents'`. The local dev workspace masked the bug because
  both libraries lived in the root `devDependencies` and were hoisted
  into `node_modules`. Both libraries are now regular `dependencies`
  of `@zhixuan92/multi-model-agent-core` (the only package whose
  source code imports them); `@zhixuan92/multi-model-agent-mcp`
  receives them transitively and no longer declares the peer block.

## [0.1.1] - 2026-04-10

Patch release for `@zhixuan92/multi-model-agent-mcp` only.
`@zhixuan92/multi-model-agent-core` remains at `0.1.0`.

### Fixed

- **mcp**: `dist/cli.js` is now executable (`chmod +x` after `tsc`),
  and a `prepublishOnly` hook runs the build before every publish.
  In `0.1.0` the file was emitted with mode `0644`, which caused
  `npm publish` to silently strip the `bin` entry from the published
  manifest with the warning `"bin[multi-model-agent]" script name
  dist/cli.js was invalid and removed`. The result was a published
  package with no `multi-model-agent` command, breaking
  `npx @zhixuan92/multi-model-agent-mcp serve` and the global install
  path. `0.1.0` has been deprecated; please use `0.1.1` or later.

## [0.1.0] - 2026-04-10

Initial public release.

### Added

#### MCP server
- `delegate_tasks` MCP tool that runs an array of tasks concurrently across configured providers, returning a result per task with status, output, token usage, turn count, and the list of files written.
- Auto-routing: when a task omits `provider`, the server picks the cheapest configured provider that satisfies the task's `requiredCapabilities` and `tier`. Tie-breaks by provider name.
- Live routing matrix in the MCP tool description so the orchestrating model sees provider names, model ids, supported tools, quality tier, effective cost tier, and `effort` support based on the loaded config.
- Stdio transport via `multi-model-agent serve` (or `npx @zhixuan92/multi-model-agent-mcp serve`).
- Config discovery in this order: `--config <path>` argument, `MULTI_MODEL_CONFIG` environment variable, `~/.multi-model/config.json`.

#### Provider runners
- **Claude** runner using `@anthropic-ai/claude-agent-sdk`. Supports `effort` (`none` / `low` / `medium` / `high`), built-in `WebSearch` / `WebFetch`, and a custom MCP code-tools server for file/grep/glob operations.
- **Codex** runner using the OpenAI Responses API against the `chatgpt.com/backend-api/codex` endpoint when `codex login` credentials are present, falling back to `OPENAI_API_KEY` against the public OpenAI API. Supports `effort`, hosted `web_search`, and the multi-turn function-call loop.
- **OpenAI-compatible** runner using `@openai/agents` (optional peer). Pointed at any OpenAI-compatible base URL via `baseUrl` plus `apiKey` or `apiKeyEnv`.

#### Capabilities and routing
- Capability matrix per provider: `file_read`, `file_write`, `grep`, `glob`, `shell`, `web_search`, `web_fetch`.
- Quality tiers: `trivial`, `standard`, `reasoning`. Tier filtering uses model profiles in `packages/core/src/routing/model-profiles.json`.
- Cost tiers: `free`, `low`, `medium`, `high`. `costTier` in provider config overrides the model-profile default and is shown as `(from config)` in the routing matrix.
- Per-task `tools` and `sandboxPolicy` overrides.

#### Tool sandbox
- Default `sandboxPolicy: cwd-only` confines `readFile`, `writeFile`, `grep`, `glob`, and `listFiles` to the task's `cwd`. Path traversal and symlinks pointing outside `cwd` are rejected via `fs.realpath` resolution.
- `runShell` is hard-disabled under `cwd-only` and only available when `sandboxPolicy: none` is set explicitly per-provider or per-task.
- File size caps to prevent host OOM / disk-fill: `readFile` rejects targets larger than 50 MiB, `writeFile` rejects content larger than 100 MiB. Both are checked **before** allocating memory or touching disk.

#### Configuration
- Zod-validated config schema for providers and defaults. All numeric limits (`maxTurns`, `timeoutMs`) must be positive integers.
- `apiKeyEnv` pattern for storing secrets in environment variables instead of inline in the config file. The server emits a warning at config-load time if an inline `apiKey` is found.
- `effort` and `hostedTools` per provider with sensible defaults (Codex auto-enables `web_search` unless `hostedTools` is explicitly set).

#### Security defenses
- One-time stderr warning when `~/.codex/auth.json` is group- or world-readable, with a `chmod 600` hint. Skipped on Windows.
- One-time stderr warning at module load when `CODEX_DEBUG=1` is set, since debug mode logs raw request/response bodies (prompts, file contents) to stderr.
- Per-task and per-provider `timeoutMs` and `maxTurns` enforcement via the `withTimeout` wrapper and an `AbortController` plumbed into all runners.

#### Packaging
- Monorepo split into two publishable packages:
  - `@zhixuan92/multi-model-agent-core` — runtime library (routing, config, runners, tool sandbox).
  - `@zhixuan92/multi-model-agent-mcp` — MCP stdio server binary.
- ESM-only, Node `>= 22`.
- `@openai/agents` and `openai` are optional peer dependencies — only required for `openai-compatible` providers.

#### Tests
- 220 Vitest tests across 20 files covering config schema, routing eligibility and selection, provider dispatch, all three runners (with `vi.mock`'d SDKs and a regression test for the multi-turn replay bug fixed in this release), tool sandbox boundaries, MCP CLI config discovery, package export contracts, and the file-size guards.

[Unreleased]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zhixuan312/multi-model-agent/releases/tag/v0.1.0
