# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-04-11

Both `@zhixuan92/multi-model-agent-core` and `@zhixuan92/multi-model-agent-mcp` bump to `0.4.0` in lockstep. Core picks up a supervision-layer fix and a new `TaskSpec` field; MCP ships the ROI headline and two new telemetry tools.

### Added

- **ROI headline on every `delegate_tasks` response (mcp).** New `headline` field at the top of both `full` and `summary` mode envelopes — a pre-computed one-line summary of tasks / success rate / wall-clock / serial savings / actual cost / saved cost / ROI multiplier. The calling agent quotes it verbatim with no arithmetic. When a single `parentModel` is declared across the batch, the headline includes a full cost-savings clause with an `Nx ROI` multiplier. When tasks declare different parent models (mixed baselines), the multiplier is suppressed and the clause reads `$X actual / $Y saved vs multiple baselines` — the `$saved` number is still a valid additive dollar quantity but a single ratio across different baselines is not coherent and is deliberately not emitted.
- **`get_batch_telemetry(batchId)` MCP tool (mcp).** Returns a compact envelope with `headline`, `timings`, `batchProgress`, `aggregateCost`, and a per-task cost/timing rollup. Envelope size is a constant ~600-byte header plus ~200 bytes per task, so a typical 10–30-task batch comes back at 2–7 KB (well under any client-side tool-result size limit); batches approaching 200+ tasks scale linearly and may approach the limit. Use as a single-call escape hatch when the primary `delegate_tasks` response came back in explicit `full` mode and the client-side size limit obscured the envelope. Timings are recomputed from the cached `results[]` with `wallClockMs ≈ max(durationMs)` as a lower-bound estimate — the batch cache shape is not modified.
- **`get_task_detail(batchId, taskIndex)` MCP tool (mcp).** Returns the bulky per-task fields (`toolCalls: string[]`, `filesRead`, `filesWritten`, `directoriesListed`, full `escalationLog` with `reason` strings, `progressTrace` when opted in) that were moved out of summary mode. Use when you need to inspect what a specific task actually did — debug a failure, verify file-write scope, or review the provider escalation chain.
- **`escalationChain: string[]` field on summary-mode `results[]` entries (mcp).** A one-line representation of the provider walk formatted as `<provider>:<status>` per attempt. Examples: `["minimax:ok"]` for a one-shot task, `["minimax:incomplete","codex:ok"]` for a walked chain, `["minimax:error","codex:api_error","claude:timeout"]` for an all-failed task. The full `AttemptRecord[]` with `reason` strings is available via `get_task_detail`.
- **`TaskSpec.skipCompletionHeuristic?: boolean` (core + mcp).** Opt-out field for tasks whose expected output is short and structured (single-line verdicts, CSV rows, opaque identifiers) and would trip the runner's default `no_terminator` / `fragment` short-output heuristic. When `true`, those two degeneracy checks are skipped; `empty` and `thinking_only` still fire. Exposed in the MCP `delegate_tasks` Zod schema as an optional boolean.
- **`validateSubAgentOutput(text, opts)` coordinator (core).** New exported helper in `packages/core/src/runners/supervision.ts` that runs `empty`/`thinking_only` → `expectedCoverage` → `skipCompletionHeuristic` → default short-output heuristic in the correct priority order. The existing `validateCompletion` and `validateCoverage` functions are unchanged internally — the coordinator wraps them.

### Changed (BREAKING)

- **`delegate_tasks` `summary`-mode `results[]` shape is slimmed (mcp).** The per-task entries no longer carry `toolCalls`, `filesRead`, `filesWritten`, `directoriesListed`, `progressTrace`, or the full `escalationLog[].reason` strings inline. Call `get_task_detail({ batchId, taskIndex })` for those fields. The rename from `_fetchWith` → `_fetchOutputWith` is part of the same breaking change; a new `_fetchDetailWith` sibling points at `get_task_detail`. Full mode (`responseMode: "full"`) is unchanged — every existing per-task field still appears inline. Only summary mode's `results[]` shape changed.

### Fixed

- **Supervision false-positive on tight-format outputs (core).** When a task declared `expectedCoverage` AND the output satisfied the coverage contract, the runner was previously re-prompting anyway if the output was short and lacked terminal punctuation — the generic `no_terminator` heuristic fired before the more authoritative coverage check had a chance to run. Result: correct-but-tight outputs (e.g., `"verdict: pass, 5 sections found"`) were landing as `status: incomplete`. The priority is now inverted: `expectedCoverage`, when declared, is authoritative. Coverage pass → output is valid, short-output heuristics are skipped. `empty` and `thinking_only` still fire regardless. Affects all three runners (`openai-runner.ts`, `claude-runner.ts`, `codex-runner.ts`).

### Migration

- If your code reads `results[i].toolCalls` / `filesRead` / `filesWritten` / `directoriesListed` / `progressTrace` from a summary-mode response, replace it with a `get_task_detail({ batchId, taskIndex: i })` call and read the same field from the detail response.
- If you need the full escalation `reason` strings (debugging provider walks, auditing which worker failed on what), call `get_task_detail` and read `.escalationLog[j].reason`. For a compact one-line view of which providers were attempted, use the new `escalationChain` field directly on the summary entry.
- If you built follow-up `get_task_output` calls from `results[i]._fetchWith`, rename to `_fetchOutputWith`. Semantically identical, just a new key name.
- If you call `delegate_tasks` with explicit `responseMode: "full"` and hit a client-side tool-result size limit that obscures the response, call `get_batch_telemetry({ batchId })` afterward to get the ROI envelope in a bounded-small response. The `headline` field is still emitted at the top of full-mode responses and is visible whenever the envelope fits.
- If your delegation flow includes tight-format tasks (single-line verdicts, CSV rows, opaque identifiers) and you were seeing false-positive `incomplete` statuses, either declare `expectedCoverage` with `requiredMarkers` that identify the shape of a valid output, or set `skipCompletionHeuristic: true` on the task spec. Prefer `expectedCoverage` when the output is enumerable — it's more authoritative and catches more bug shapes.

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

[Unreleased]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v0.4.0...HEAD
[0.4.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v0.3.1...mcp-v0.4.0
[0.1.2]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zhixuan312/multi-model-agent/releases/tag/v0.1.0
