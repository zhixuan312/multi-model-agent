# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 3.1.3 — 2026-04-24

### Added

- **server (`@zhixuan92/multi-model-agent`).** Verbose mode now emits a line on every HeartbeatTimer tick (not just stage transitions) so operators can confirm the timer is firing during long-running stages. Also logs a one-line "heartbeat started" / "heartbeat DISABLED" marker at lifecycle start to surface timer-wiring issues end-to-end.

## 3.1.2 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** `mmagent serve --verbose` was silent after the initial `start worker=...` line for the entire duration of every batch. Root cause: HTTP handlers never pass `onProgress` to `runTasks`, and `run-tasks.ts` gated both HeartbeatTimer creation and `wrappedOnProgress` on `onProgress !== undefined`. The provider runners emit `tool_call` and `turn_complete` events correctly, but with no wrapper to receive them they were dropped. Now gates on "any verbose/logger/recordHeartbeat consumer is present" — so `--verbose` actually streams tool calls and LLM turns as the worker runs.
- **server (`@zhixuan92/multi-model-agent`).** `GET /batch/:id` returned `1/1 queued` plain-text body for every poll during a pending batch, no matter how long the batch ran. `BatchEntry.tasksStarted` was declared in the schema but never written. `asyncDispatch` now sets `tasksTotal=1, tasksStarted=1` when the executor begins, and `tasksCompleted=1` before marking the batch complete. `composeRunningHeadline` now transitions to `1/1 running, Xs elapsed` as intended. Added `tests/server/async-dispatch-progress-wiring.test.ts` as a regression guard.

## 3.1.1 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** `startServe()` was stripping `agents` from the config before handing it to `startServer()`, so every tool endpoint (`POST /delegate`, `/audit`, `/review`, etc.) returned `503 no_agent_config` even when the config file had agents properly defined. Regression introduced during 3.1.0's Phase 1 refactor. Now passes the full MultiModelConfig through so `registerToolHandlers` sees agents and wires real handlers. Added `tests/cli/serve-agents-passthrough.test.ts` as a regression guard. 3.1.0 is npm-deprecated; upgrade to 3.1.1.

## 3.1.0 — 2026-04-24

### BREAKING

- **`GET /batch/:id` response shape split by HTTP status.** Pending → `202 text/plain` plain-text progress line. Terminal → `200 application/json` full envelope. No `state` field — consumers branch on HTTP status. Migration: one conditional per call site.
- **Response envelope uniformity.** Every terminal JSON envelope now has all seven fields (`headline`, `results`, `batchTimings`, `costSummary`, `structuredReport`, `error`, `proposedInterpretation`). Non-applicable fields are `{ kind: "not_applicable", reason: "..." }`. Consumers of `response.structuredReport.summary` etc. must type-narrow.
- **`mmagent print-token` output.** Emits only the token on stdout; warnings go to stderr.
- **Inline-apiKey warning.** No longer fires on every `loadConfigFromFile` — now fires once on `mmagent serve` startup with an actionable fix recipe.
- **Log file rename.** `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` → `mmagent-YYYY-MM-DD.jsonl`. Old files untouched.
- **`install-skill` default.** No positional skill name now installs every shipped skill (was: error). Specify a skill name to scope to one.

### Added

- `mmagent info [--json]` subcommand: cliVersion, bind/port, token fingerprint, and daemon identity (version/pid/startedAt/uptimeMs via `/health`). Works offline (returns `NotApplicable` sentinels when daemon unreachable).
- `mmagent update-skills [--dry-run] [--json] [--if-exists] [--silent] [--best-effort]` subcommand: re-copies every manifest-tracked skill from the shipped bundle, updates `skillVersion`, removes skills no longer in bundle.
- `mmagent logs [--follow] [--batch=<id>]` subcommand: tails today's `mmagent-*.jsonl` with POSIX-sh tail-F semantics.
- `server.autoUpdateSkills` config field (default `true`). `mmagent serve` auto-updates stale skills before bind (bounded 5s; never blocks).
- `mmagent install-skill` with no positional skill name now installs every shipped skill (previous behavior required a skill name or `--all-skills` flag — 3.1.0 flips the default). Pass a skill name to scope to one. `--uninstall` with no skill name removes all installed skills.
- npm `postinstall` hook via `packages/server/scripts/postinstall.js` — zero-touch skill refresh on `npm update`. Always exits 0.
- Plain-text running headline on `GET /batch/:id` during pending. Recomposed every HeartbeatTimer tick; includes stall detection after 2× heartbeat interval.
- Startup log line `[mmagent] started | version=... | bind=... | pid=... | token=<fp> | boot=<uuid>` on stdout before listening.
- `/health` response extended with `version`, `pid`, `startedAt`, `uptimeMs`.
- Diagnostic events `task_started`, `task_heartbeat`, `task_phase_change` on `DiagnosticLogger`. `asyncDispatch` emits `task_started`; `buildExecutionContext`'s heartbeat callback emits `task_heartbeat`.
- Verbose mode: `diagnostics.verbose: boolean` config (default false) + `mmagent serve --verbose` flag. Streams per-tool-call, per-LLM-turn, per-stage-transition, and per-batch-lifecycle events to stderr so operators can profile server behavior and fine-tune efficiency. Orthogonal to log-file persistence — streams without writing any file by default.
- File-log toggle: `diagnostics.log: boolean` config (default false) + new `mmagent serve --log` flag. Decoupled from verbose — stream inline without persisting, persist without stderr noise, both, or neither.
- Verbose tool_call events include `durationMs` (time since prior event); llm_turn includes per-turn duration. New `batch_completed` and `batch_failed` events fire from asyncDispatch with total batch duration and task count / error details. Stage transitions (implementing → spec_review → spec_rework → quality_review → quality_rework) emit `task_phase_change`.
- Skill frontmatter rewrite across every mma-* skill: each describes direct user intent (audit, review, verify, debug, execute-plan, delegate) as the primary trigger and names the superpowers methodology skill it pairs with as a secondary hint. Works for users who do NOT use superpowers too.
- Skill frontmatter `version:` field (sentinel `"0.0.0-unreleased"` in source, stamped to package.json version at build time via `packages/server/scripts/inject-skill-version.mjs`).
- Migration guide at `docs/migration/2.x-mcp-to-3.x-rest.md`.

### Changed

- Manifest schema v1 → v2: per-entry `version` renamed to `skillVersion`. Auto-migrated on first load with a stderr notice; corrupt files are backed up and rebuilt empty.
- `FutureManifestError` thrown when a newer mmagent's manifest is encountered; tools refuse to mutate rather than corrupt.
- Skill curl examples use `curl -f --show-error -s` with explicit HTTP-status branching instead of `curl -sf`.
- Polling skill snippets: 30s backoff cap (up from 5s), 1800s client-side timeout, per-process `mktemp` body file with `trap` cleanup.
- Auth token file strictly validated (LF-only, `[A-Za-z0-9_\-+=/.]+` regex). `MMAGENT_AUTH_TOKEN` env override bypasses file validation.
- `mmagent help` lists five user-facing subcommands (`serve`, `print-token`, `info`, `status`, `install-skill`, `update-skills`, `logs`).

### Removed

- `state` field from `GET /batch/:id` response body (consumers branch on HTTP status instead).

## 3.0.2 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** Fixed the CLI entry's `isMain()` guard to follow symlinks. 3.0.1's bin worked when executed directly but silently exited 0 when invoked via the npm `.bin/mmagent` symlink, because `path.resolve(argv[1])` returned the symlink path, not the real file, and the identity check against `import.meta.url` failed. Now uses `fs.realpathSync(path.resolve(argv[1]))`. 3.0.1 is npm-deprecated; upgrade to 3.0.2.

## 3.0.1 — 2026-04-24

### Fixed

- **server (`@zhixuan92/multi-model-agent`).** Added missing `#!/usr/bin/env node` shebang to the CLI entry. 3.0.0's published `dist/cli/index.js` was missing the shebang, which caused `mmagent` (invoked via the bin symlink) to be parsed by `/bin/sh` instead of Node and fail with `line 1: /Applications: is a directory`. 3.0.0 is npm-deprecated; upgrade to 3.0.1.

### Changed

- **server (`@zhixuan92/multi-model-agent`).** Rewrote `packages/server/README.md` for the 3.0.0 install + serve + install-skill flow. Previous 3.0.0 tarball shipped the stale 2.x `-mcp` README.
- **core (`@zhixuan92/multi-model-agent-core`).** Rewrote `packages/core/README.md` to reference the renamed `@zhixuan92/multi-model-agent` package. Added `./executors` and `./tool-schemas` subpath entries introduced in 3.0.0.

## 3.0.0 — 2026-04-24

### BREAKING: MCP Removed

`multi-model-agent` is no longer an MCP server. All MCP transports, tool registrations, and the `@modelcontextprotocol/sdk` dependency have been removed. The package is now a standalone HTTP service with client-installable skills.

**Migration from 2.x MCP users:**
1. Remove old MCP registration: `claude mcp remove multi-model-agent`
2. Install new package: `npm i -g @zhixuan92/multi-model-agent`
3. Start the daemon: `mmagent serve` (keep running; see launchd/systemd scripts)
4. Install skills: `mmagent install-skill` (auto-detects Claude Code, Gemini CLI, Codex CLI, Cursor)

The deprecation stub `@zhixuan92/multi-model-agent-mcp@2.8.1` ships separately to surface this message to users who blindly upgrade.

### Package rename
- `@zhixuan92/multi-model-agent-mcp` → `@zhixuan92/multi-model-agent`
- `packages/mcp/` → `packages/server/` (internal only)

### Added
- REST API: 7 tool endpoints (delegate/audit/review/verify/debug/execute-plan/retry), 4 control endpoints (context-blocks, clarifications/confirm, batch), 3 introspection endpoints (health/status/tools)
- Async-with-polling dispatch: `202 { batchId, statusUrl }` + `GET /batch/:id`
- `GET /batch/:id?taskIndex=N` replaces the old MCP `get_batch_slice` tool
- Batch state machine: pending / awaiting_clarification / complete / failed / expired
- Context-block refcount pinning prevents use-after-free during active batches
- 10 installable skills via `mmagent install-skill` supporting Claude Code, Gemini CLI, Codex CLI, Cursor
- `mmagent status` / `mmagent print-token` operator commands

### Removed
- All MCP transports (stdio and HTTP)
- `@modelcontextprotocol/sdk` dependency
- `DELEGATION-RULE.md` (only meaningful with MCP)

## [2.8.0] - 2026-04-23

### Added

- **HTTP transport (mcp).** New opt-in `mmagent serve --http` mode that runs the MCP server as a long-running HTTP/SSE daemon, independent of any Claude Code session's lifetime. The daemon survives Claude Code lifecycle events (compaction, `/clear`, session exit, client crash) that previously tore down the stdio child process and produced "MCP server is down" errors on the next tool call. Stdio remains the default transport; HTTP is opt-in via `--http` flag or `transport.mode: "http"` in config. See the new "Running as an HTTP daemon" section of `packages/mcp/README.md`.
- **Concurrent multi-project sessions (mcp).** A single HTTP daemon serves multiple Claude Code sessions concurrently, each bound to its own project directory via a `?cwd=/abs/path` URL query param on the MCP endpoint. Per-project `ProjectContext` isolates context blocks, batch cache, and clarifications so sessions cannot see each other's state.
- **`transport` config block (core).** New top-level field on `~/.multi-model/config.json`: `{ "transport": { "mode": "stdio" | "http", "http": { bind, port, auth: { enabled, tokenPath }, projectIdleEvictionMs, projectCap, shutdownDrainMs, sessionIdleTimeoutMs } } }`. All fields optional with sensible defaults (stdio mode, port 7312, loopback bind, auth off, 60-min project eviction, 30-min session idle timeout, 30-s shutdown drain). Omitting the block preserves the pre-2.8.0 stdio behavior exactly.
- **Token-based auth (mcp).** Enable via `transport.http.auth.enabled: true`. The daemon generates a 32-byte random token at `~/.multi-model/runtime/token` (mode 600) on first boot and reads it on subsequent boots. Clients present it via `Authorization: Bearer <token>`. Tokens in the query string are explicitly rejected with 401 (prevents leaks via access logs and process listings). A startup safety check refuses to bind to non-loopback addresses unless auth is enabled.
- **Graceful SIGTERM drain (mcp).** In HTTP mode, SIGTERM triggers a global drain: stop accepting new connections, notify active sessions via SSE, wait up to `shutdownDrainMs` for in-flight handlers, then force-close. Shutdown is logged as `SIGTERM` on clean drain or `SIGTERM_drain_timeout` on escalation. SIGHUP is a no-op in HTTP mode (stdio behavior unchanged).
- **Session idle timeout (mcp).** Defense-in-depth against clients that don't call `terminateSession()` on disconnect. A periodic timer (1-min tick) detaches sessions with no request activity for `sessionIdleTimeoutMs` (default 30 min). Emits `session_close reason='session_expired'`. Project stores survive the session eviction so reconnecting clients keep their state.
- **`/status` endpoint (mcp).** Loopback-only `GET /status` returns daemon version, pid, uptime, bind, auth status, per-project stats (sessions, batch cache size, context blocks size, clarifications size), active requests with progress headlines, and a rolling 10-entry recent-requests buffer. Auth-gated when `auth.enabled=true`.
- **`mmagent status` CLI (mcp).** New subcommand that fetches `/status` and formats a human-readable summary. `--json` flag for scripting.
- **`mmagent` bin alias (mcp).** Short alias for `multi-model-agent`. Both binaries point at the same CLI; existing `multi-model-agent` invocations continue to work.
- **New diagnostic log event types (core).** HTTP mode adds `session_open`, `session_close`, `connection_rejected`, `request_rejected`, `project_created`, `project_evicted` to the log stream. `startup` now includes a `transport: 'stdio' | 'http'` field. `request_start` / `request_complete` gain optional `sessionId` and `cwd` fields (both omitted under stdio for backward compatibility). Shutdown cause set extended with `'SIGTERM_drain_timeout'`.
- **`ProjectContext` type (core).** New exported type bundling per-project stores (`InMemoryContextBlockStore`, `BatchCache`, `ClarificationStore`) plus lifecycle metadata (`cwd`, `createdAt`, `lastSeenAt`, `activeSessions`, `activeRequests`, `pendingReservations`). Synthesized once from `process.cwd()` in stdio mode; created per unique `cwd` in HTTP mode. `createProjectContext(cwd)` factory.
- **`BatchCache` class (core).** Extracted from `cli.ts`'s previously-inline Map closures into a named class with explicit status enum (`'pending' | 'complete' | 'aborted'`) and `complete()` / `abort()` state-transition methods. Preserves the 30-min TTL + 100-entry LRU semantics.
- **launchd + systemd service templates (mcp).** New `packages/mcp/scripts/launchd/` and `packages/mcp/scripts/systemd/` with install instructions for running the HTTP daemon as a user service.

### Changed

- **`buildMcpServer` signature (mcp, breaking).** `options` parameter is now **required** and must contain `projectContext: ProjectContext`. Also accepts optional `sessionId?: string`. The three in-memory stores are read from `projectContext` rather than constructed locally — so `buildMcpServer` no longer creates state, it accepts it. Stdio callers synthesize a single `ProjectContext` from `process.cwd()`; HTTP callers construct one per unique `cwd`. Per the development-mode rule, every in-repo call site updates in the same commit (production + tests).
- **`injectDefaults` cwd source (mcp).** Now reads `cwd` from `projectContext.cwd` instead of `process.cwd()`. In stdio mode these are equal; in HTTP mode each session gets the correct per-project cwd.
- **Delegation rule (rules).** Clarified auto-pipeline behavior when MCP is unreachable: stop and report rather than falling back to inline labor. Added "When MCP is down" section to `.claude/rules/DELEGATION-RULE.md`.

### Why

- End users kept reporting "MCP server is down" mid-workflow. Investigation of diagnostic logs across multiple incidents showed the same root cause in every case: Claude Code closed the stdin pipe to the MCP child process (compaction, `/clear`, session exit) and the child dutifully exited with `cause: stdin_end`. The MCP was not crashing — it was being terminated by its parent, and under the stdio transport the MCP server is structurally a child of the client with no way to survive the pipe close. The only path to "MCP survives client churn" is a different transport where the server is not a child of the client. HTTP transport delivers that. Stdio remains the default and unchanged for users who don't opt in; HTTP is additive.



### Changed

- **Diagnostic logging switch moved to the agent config (core, breaking).** Enable/disable and directory override now live in `~/.multi-model/config.json` under a new `diagnostics` block: `{ "diagnostics": { "log": true, "logDir": "/optional/path" } }`. Default remains off. 2.7.4's `MCP_DIAGNOSTIC_LOG` and `MCP_DIAGNOSTIC_LOG_DIR` environment variables are removed entirely — there is no precedence or override layer to reason about. Users who enabled logging in 2.7.4 must move the switch from their MCP client's `env` block into their agent config.
- **`createDiagnosticLogger` signature (breaking).** Now requires an explicit `{ enabled: boolean, logDir?: string }` options object. The logger no longer reads any environment variables. Callers (only `packages/mcp/src/cli.ts` in-repo) pass `config.diagnostics?.log ?? false` and `config.diagnostics?.logDir`.

### Why

- 2.7.4 required users to edit their MCP client's `env` block — a separate surface from the agent config they already maintain at `~/.multi-model/config.json`. Consolidating both knobs into the agent config makes enabling the crash log a one-line edit in the file users already know about, and eliminates an entire class of precedence/override bugs.

## [2.7.4] - 2026-04-21

### Changed

- **Diagnostic logger is opt-in (core, breaking).** The logger created by `createDiagnosticLogger()` is now a complete no-op unless `MCP_DIAGNOSTIC_LOG` is set to a truthy value (`1`, `true`, `yes`, or `on`, case-insensitive). When disabled, the logger performs no directory creation, no file opens, no stat calls — every public method early-returns. When enabled, logs still land at `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` (overridable via `MCP_DIAGNOSTIC_LOG_DIR`). Replaces 2.7.3's on-by-default behavior.
- **Event schema reshaped to 5 types (core, breaking).** The logger now writes exactly `startup`, `request_start`, `request_complete`, `shutdown`, and `error`. Previously-emitted `notification_batch` events (one per 5-second progress burst) are removed entirely — they dominated log volume without aiding crash diagnosis. The old single `request` event is split into `request_start` (emitted before the handler runs) and `request_complete` (emitted after), so the log retains the in-flight tool if the process dies mid-request.
- **Startup banner suppressed when disabled (mcp).** The `[multi-model-agent] diagnostic log: <path>` stderr line now prints only when logging is enabled.

### Added

- **Expanded signal coverage (mcp).** `installStdioLifecycleHandlers` now registers handlers for `SIGTERM`, `SIGINT`, `SIGPIPE`, `SIGHUP`, `SIGABRT`, and `beforeExit`. Each writes a `shutdown` line with the matching `cause` before exit (0 for graceful signals and `stdin_end`; 1 for error-class signals, `uncaughtException`, and `unhandledRejection`). Previously these signals terminated the process with zero log output, indistinguishable from a segfault.
- **`unhandledRejection` is fatal (mcp, breaking).** A rejected promise without a handler now logs an `error` event, emits a `shutdown` with cause `unhandledRejection`, and exits 1. Previously the server logged the rejection and kept running, which could leave the process in a wedged half-alive state.
- **`lastRequestInFlight` on shutdown (core).** If a request is in flight when any shutdown path fires, the `shutdown` line includes `{ requestId, tool, startedAt }` for the most-recent in-flight request, letting us attribute a crash to the tool that was running.
- **Duplicate `requestId` detection (core).** A second `requestStart` for an already-in-flight requestId now writes an `error` event with `kind: "duplicate_request_id"` before replacing the entry, preventing silent diagnostic corruption from buggy callers.

### Removed

- **`notification_batch` event type (core, breaking).** Progress notifications are still delivered to MCP clients via `notifications/progress`; only the logger-side batching output is gone.
- **`progressToken` field on request events (core, breaking).** MCP progress tokens are a consumer-side concern, not a diagnostic one.
- **`NonTerminalErrorCause` from `@zhixuan92/multi-model-agent-core` public exports.** The type only described the old `notification_batch`/`unhandledRejection` error envelope.

### Why

- The 2.7.3 logger shipped on-by-default and was dominated by repeated `notification_batch` lines — in a real disconnect report, ~90% of lines carried no diagnostic signal. Worse, `SIGTERM`/`SIGPIPE` kills still produced zero log output, so a genuine crash and a healthy idle process looked identical at the tail of the file. 2.7.4 treats the log as a crash-diagnosis tool only: off by default so there's no surprise disk write, focused on the events that distinguish "process exited cleanly via stdin_end" from "process was signal-killed" from "process died mid-request." Users who hit a disconnect can enable `MCP_DIAGNOSTIC_LOG=1`, reproduce, and share the resulting file.

## [2.7.3] - 2026-04-20

### Added

- **Stdio lifecycle handlers (mcp).** `installStdioLifecycleHandlers(logger)` registers EPIPE-safe handlers on `process.stdout`, `process.stdin`, `uncaughtException`, and `unhandledRejection`. Without these the server crashed silently when the client closed its read end of the pipe (the "MCP dies every ~2 calls" failure). Single-install contract; a second call is a no-op with a stderr warning.
- **Diagnostic logger (core).** New `@zhixuan92/multi-model-agent-core/diagnostics/disconnect-log` module exports `createDiagnosticLogger()` / `DiagnosticLogger`. The logger writes JSON-Lines events to `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` — one file per UTC day, lazy-materialised on first write, best-effort fs (a broken disk never breaks a working server). Four event shapes: `request` (per tool call with tool, requestId, progressToken, durationMs, responseBytes, status), `notification_batch` (one summary per 5-second burst with attempted/succeeded counters and `since` timestamp), `error` (non-terminal background errors — currently `unhandledRejection`), and `shutdown` (terminal, written synchronously before exit, carries cause, lastRequest with msSinceCompletion, and notificationsSinceLastRequest counters).
- **Per-tool request events (mcp).** Every specialised tool (`audit_document`, `debug_task`, `execute_plan`, `review_code`, `verify_work`, `confirm_clarifications`) now emits a `request` event on each invocation via a new `withDiagnostics(tool, logger, handler)` wrapper in `tools/shared.ts`. Measures wall-clock duration and approximate response-body bytes; on a thrown handler, logs `status: 'error'` with `responseBytes: 0` before rethrowing.
- **Startup banner (mcp).** During normal `serve` startup the server prints exactly one line to stderr: `[multi-model-agent] diagnostic log: <path>`. No new output for healthy users beyond that banner.

### Changed

- **`buildMcpServer` signature (breaking).** Now takes `(config, logger, options?)` — every in-repo caller and test helper updated in the same change. Tests that construct a server pass a no-op logger via `tests/tools/helpers.ts#makeNoopLogger()`.
- **`installStdioLifecycleHandlers` signature (breaking).** Now requires a `DiagnosticLogger` parameter; idempotent with a stderr warning on second install.

### Why

- End users reported "MCP dies every 1–2 calls" with no stack trace. The lifecycle handlers stop the silent crash on EPIPE; the logger captures the *cause* of the death so we can fix the actual root trigger in a follow-up release. Users on 2.7.3 who still hit disconnects can share `~/.multi-model/logs/mcp-YYYY-MM-DD.jsonl` to make the cause visible.

## [2.7.2] - 2026-04-20

### Added

- **File artifact verification (core).** Tasks with `filePaths` containing non-existent paths (output targets) now verify those files exist after all work completes. If any output target is still missing, `status` downgrades from `ok` to `incomplete` and `fileArtifactsMissing` is set to `true`. Uses exact normalized path comparison via `fs.existsSync` against the final state (post-rework, post-commit).
- **Auto-commit (core).** New `autoCommit` field on `TaskSpec`. When true, the platform commits `filesWritten` via git after the worker finishes (and after each rework round). Commit message is derived from the worker's structured report summary. Uses `execFileSync` with argument arrays for shell safety. "Nothing to commit" is treated as a benign no-op. Commit SHA and any error are returned in `commitSha`/`commitError` on `RunResult`.
- **Preset auto-commit (mcp).** `delegate_tasks`, `execute_plan`, `debug_task`, and `retry_tasks` now set `autoCommit: true` by default. Read-only tools (`audit_document`, `review_code`, `verify_work`) do not.

### Changed

- **Delegation rule updated.** Plan auditing now routes through `review_code` (with plan + referenced source files) instead of `audit_document`, giving the auditor codebase access to validate type/function assumptions. Positive language throughout, rationale added for all rules, response handling reformatted as a table.

## [2.7.1] - 2026-04-19

### Fixed

- **Review verdicts feed into status (core).** Spec or quality review exhausting all rework rounds without approval now downgrades `status` from `ok` to `incomplete`. Previously, review verdicts were attached as metadata (`specReviewStatus`, `qualityReviewStatus`) but never influenced the top-level `status` field — callers saw `ok` for work that review rejected.
- **Spec reviewer catches partial edits (core).** The spec review prompt now includes a completeness instruction that checks whether each required target was adequately addressed. Flags `changes_required` only on positive evidence of omission (e.g., task names targets A, B, C but only A and B appear in modified files).

## [2.7.0] - 2026-04-19

### Added

- **Unified response envelope (mcp).** All 8 MCP tools (`delegate_tasks`, `retry_tasks`, `confirm_clarifications`, `audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`) now return the same JSON shape: `{ headline, batchId, results: [{ status, output, filesWritten }] }`. Verbose telemetry fields (`usage`, `turns`, `escalationLog`, `agents`, `models`) are only available via `get_batch_slice`.
- **Auto-escape truncation (mcp).** Large outputs are truncated inline with a `[Output truncated...]` suffix pointing to `get_batch_slice`, replacing the old full/summary response mode split. Proportional budget allocation redistributes surplus from short outputs to long ones.
- **Plan-literal execution (core).** `execute_plan` compiler now instructs workers to follow the plan exactly as written, use code blocks verbatim, and not redesign or substitute their own approach.
- **Lenient review parsing (core).** `parseStructuredReport` now accepts `# Summary` (h1), `**Summary**` (bold), `Summary:` (colon), and plain first-paragraph as implicit summary — reducing review parse failures from format variation.
- **Review retry on parse failure (core).** `runSpecReview` and `runQualityReview` retry once with stronger format instructions when the first attempt produces an unparseable response.
- **Context block LRU-refresh (core).** Accessing a context block now resets its TTL, preventing frequently-used blocks from expiring mid-workflow.

### Changed

- **`get_batch_slice` simplified (mcp).** The `slice` parameter is removed. Now takes `{ batchId, taskIndex? }` and returns full telemetry + results. Error cases return content text instead of throwing.
- **`register_context_block` response simplified (mcp).** Returns `{ contextBlockId }` instead of the full registration metadata.
- **`responseMode` removed from `delegate_tasks` and `retry_tasks` (mcp).** The full/summary/auto mode selector is replaced by deterministic auto-escape truncation. Callers no longer choose a mode.
- **Default `maxReviewRounds` reduced from 10 to 5 (core).** Limits review cycles to 5 rounds across all review paths.

### Fixed

- **Audit compiler re-read instruction (core).** Delta audit prompts now instruct workers to re-read target files before comparing against prior findings, and begin with a findings count line.
- **Status promotion for shell-verified work (core).** Workers that self-report `done` and ran shell commands (e.g., `npm test`) are now promoted from `incomplete` to `ok`, even without `filesWritten`.
- **Context block error messages (core).** `ContextBlockNotFoundError` now includes recovery guidance: retry without `contextBlockIds` or re-register via `register_context_block`.
- **Heartbeat headline for specialized tools (mcp).** Specialized tools now emit `[task N] headline` format for progress notifications, matching `delegate_tasks`.

### Removed

- **Stall detection (core).** Removed `STALL_HEARTBEAT_THRESHOLD`, `setInFlight()`, `stallCount`, and the `stalled` field from `ProgressEvent`. The stall mechanism produced false positives and added complexity without actionable signal.
- **Old response builders (mcp).** Deleted `buildMetadataBlock`, `buildFanOutResponse`, `buildClarificationAwareResponse`, `shared-intake.ts`, and `clarification-response.ts` — all replaced by `buildUnifiedResponse`.

## [2.6.1] - 2026-04-19

### Fixed

- **Heartbeat progress notifications (mcp).** MCP progress notifications now send the human-readable `headline` string (e.g., `[1/5] Implementing (gpt-5.4) — 15s, 3 read, 0 written, 6 tool calls`) instead of a raw JSON dump of the full `ProgressEvent`. Clients that truncate the `message` field now display useful status instead of cut-off JSON.

## [2.6.0] - 2026-04-19

### Added

- **Progress event consolidation (core).** The 9-variant `ProgressEvent` discriminated union is replaced by a single heartbeat shape. The old union is renamed to `InternalRunnerEvent` for internal runner-to-orchestrator telemetry. HeartbeatTimer is the sole parent-facing emitter — runners keep emitting internal events, but `run-tasks.ts` intercepts them for live counter updates and stops forwarding to the parent.
- **Enriched heartbeat (core).** `ProgressEvent` now carries `provider` (current model name), `costUSD` / `savedCostUSD` (running cost with ROI), `final` (terminal marker), and `transition()` for atomic multi-field updates with stage invariant enforcement. Headline format: `[1/3] Implementing (claude-sonnet-4-6) — 10m 20s, $0.12 saved (4.2x), 4 read, 2 written, 12 tool calls`.
- **Dynamic stage count (core).** `stageCount` is computed from `reviewPolicy` at start: `off` → 1, `spec_only` → 3, `full` → 5. Semantic stage positions allow backward transitions on review re-entry (e.g. spec_rework → spec_review).
- **`hasFileArtifacts` in supervision (core).** `validateSubAgentOutput` now accepts `hasFileArtifacts` in its priority chain — when a worker self-reports `done` and has written files, the output is trusted even if it looks like a fragment. Reduces false-incomplete statuses.
- **Plan-aware spec reviewer (core, mcp).** For `execute_plan` tasks, the spec reviewer prompt now includes the matched plan section as `## Plan Context`, so the reviewer checks implementation against the plan — not just the brief summary.

### Changed

- **`ProgressEvent` is now heartbeat-only (core).** Breaking change for consumers that pattern-matched on `turn_start`, `tool_call`, `text_emission`, `turn_complete`, `injection`, `escalation_start`, `retry`, or `done` variants. Use `InternalRunnerEvent` for internal telemetry.
- **`HeartbeatTimer` API redesigned (core).** Constructor now requires `provider` and accepts optional `parentModel`. New methods: `transition()`, `setProvider()`, `updateCost()`. `stop()` is idempotent and emits a final flush with `final: true`. `setPhase()` removed.

## [2.5.0] - 2026-04-18

### Added

- **`context` field on `execute_plan` (mcp).** Optional string for short additional context the plan doesn't contain (e.g., "Tasks 1-16 are done, files already exist"). Injected into the worker prompt as `Additional context:`.

### Changed

- **Tool routing guidance clarified (mcp).** `delegate_tasks` description now explicitly states it is the general-purpose fallback — try specialized tools first (`audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`). `execute_plan` description clarifies: use when a plan file exists on disk; use `delegate_tasks` for ad-hoc work with no plan file.

## [2.4.4] - 2026-04-18

### Added

- **`execute_plan` specialized route (core, mcp).** New MCP tool that accepts task descriptors and plan/spec file paths — the worker reads the plan, finds the matching task heading, and implements it. Multiple tasks execute in parallel. Preset: standard agent, full review. Includes `ExecutePlanSource` type, route defaults, output contract, compiler with 8 tests, and full MCP tool handler.
- **Context block auto-registration (mcp).** All five specialized routes (`audit_document`, `review_code`, `verify_work`, `debug_task`, `execute_plan`) now auto-register their output as a context block after execution and return the `contextBlockId` in metadata. Callers pass this ID directly as `contextBlockIds` in follow-up calls (e.g., round 2 of an audit) without calling `register_context_block` — eliminates redundant parent token spend on re-transmitting full output text.

## [2.4.3] - 2026-04-17

### Fixed

- **Saved-cost calculation in specialized tools (mcp).** `audit_document`, `review_code`, `verify_work`, and `debug_task` resolved `parentModel` from config but never set it on the `TaskSpec` passed to the runner. The runner returned `savedCostUSD: null`, causing headlines to display `$0.00 saved` despite actual cost savings. All four tools now propagate `parentModel` into the task spec.

### Added

- **parentModel propagation tests (mcp).** 18 new tests across the four specialized tools covering `parentModel` flow into task specs, headline saved-cost display (single-task and fan-out), and headline actual-cost fallback when `parentModel` is absent.

## [2.4.2] - 2026-04-17

### Fixed

- **Headline with saved cost in specialized tools (mcp).** `audit_document`, `review_code`, `verify_work`, and `debug_task` were missing the headline and `savedCostUSD` in their single-task and fan-out responses. Only `delegate_tasks` included them. All response paths now compose a headline via `composeHeadline` and include `savedCostUSD` in usage metadata, matching the `delegate_tasks` behavior.

## [2.4.1] - 2026-04-17

### Added

- **Saved-cost headline (mcp).** When `parentModel` is set in config defaults, the headline shows `$Y saved vs model (Zx ROI)` instead of `$X actual`. Without `parentModel`, the headline shows `$X actual` as before. `parentModel` is a single server-level config field (env var `PARENT_MODEL_NAME` or `defaults.parentModel`), not per-task.
- **12-provider model profiles (core).** Expanded from 5 flat entries to 30 profiles across Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek, Meta, Alibaba, Zhipu, Moonshot, Cohere, and MiniMax. Hierarchical prefix matching with inheritance — child profiles only override what changes from their parent.

### Changed

- **Model profiles JSON redesigned (core).** Restructured from flat array to provider groups with shared defaults, prefix inheritance, short field names (`input`/`output`/`cost`), and a `naming` field documenting each provider's model ID convention. The loader resolves inheritance at startup and validates every resolved profile against the existing Zod schema.
- **Headline simplified to one parent model (mcp).** Removed per-task `parentModel` and mixed-baselines logic. The headline now derives `parentModel` from server config, not from individual task specs.

## [2.4.0] - 2026-04-17

### Added

- **Delta audit mode (mcp).** `audit_document` automatically switches to delta mode when `contextBlockIds` is present — performs a full audit, verifies which prior findings were fixed, omits fixed findings from output, and ends with a fixed-findings summary.
- **Delta review mode (mcp).** `review_code` automatically switches to delta mode when `contextBlockIds` is present — same pattern as delta audit.
- **Context blocks in specialized tools (mcp).** All four preset tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now accept `contextBlockIds` directly, with the context block store threaded from the MCP server. No need to drop to `delegate_tasks` for context-aware workflows.
- **Model name in response (core, mcp).** New `models` field on `RunResult` with actual model names (e.g. `"MiniMax-M2.7"`) for `implementer`, `specReviewer`, `qualityReviewer`. Surfaced in full response, summary detail slice, fan-out response, and preset metadata blocks.

### Changed

- **Heartbeat elapsed format (core).** `elapsedMs: number` replaced with `elapsed: string` — human-readable format (`"50s"`, `"1m 30s"`) with 0 decimal places.
- **Default `briefQualityPolicy` changed from `'normalize'` to `'warn'` (core).** The `'normalize'` policy value is removed entirely since the normalizer was dead code.

### Removed

- **Normalizer (core).** Deleted `normalize-brief.ts`, `normalization-budget.ts`, and all threading: `normResult` parameter, `normalizationDecisions` field from structured reports, `normalizedPrompt` renamed to `prompt` in reviewer packets, `agents.normalizer` removed from response, `'normalize'` removed from `BriefQualityPolicy` and `ReadinessResult.action`.

## [2.3.0] - 2026-04-17

### Added

- **Progress heartbeats (core, mcp).** New `HeartbeatTimer` emits `{ kind: 'heartbeat', elapsedMs, turnsCompleted, phase }` events every 5 seconds during task execution, with phase transitions from `'implementing'` to `'reviewing'`. All preset tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now forward progress notifications to MCP clients via a shared `buildRunTasksOptions` helper.
- **`not_applicable` review status (core).** Tasks that produce no file artifacts (greetings, audits, read-only work) now return `specReviewStatus: 'not_applicable'` instead of sending empty packets to the reviewer that always errored on parse.
- **`specReviewReason` / `qualityReviewReason` fields (core, mcp).** Every non-`approved` review status now carries a human-readable reason string explaining why: `'reviewer output missing ## Summary section'`, `'task produced no file artifacts to review'`, `'skipped: reviewPolicy is off'`, etc. Surfaced in MCP response envelopes, detail slices, and preset metadata blocks.

### Fixed

- **Unsafe type casts removed in `confirm_clarifications` (mcp).** `registerConfirmClarifications` now accepts properly typed `TaskSpec[]`/`RunResult[]`/`RunTasksOptions` signatures instead of `unknown[]` with `as unknown as` casts. `RunTasksOptions` exported from core barrel.

## [2.2.0] - 2026-04-17

### Changed

- **Supervision thresholds relaxed (core).** `DEFAULT_MIN_LENGTH` reduced from 200 to 10, `MAX_DEGENERATE_RETRIES` from 10 to 3. Fragment detection restructured to run before the length auto-accept (capped at 120 chars) so real mid-work stalls are still caught while valid short responses pass immediately. Eliminates multi-minute hangs on simple tasks like greetings.
- **Preset tools bypass readiness and carry done conditions (mcp).** All four preset tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now set `briefQualityPolicy: 'off'` so the readiness layer never refuses internally-constructed briefs. Each tool also carries a purpose-specific `done` condition derived from its parameters (e.g., audit type, review focus, checklist length) so the worker has clear success criteria.

## [2.1.1] - 2026-04-17

### Changed

- **READMEs updated for 2.1.0 (root, core, mcp).** Tool count 8→9, `confirm_clarifications` added to tool tables, lifecycle diagram updated, version pin examples updated, `done` field description corrected, intake subpath exports added to core README.
- **Delegation rule made version-agnostic.** Removed version-specific references, reframed briefing guidance to reflect MCP interpretation model, simplified response handling, clarification handling integrated naturally into pipeline steps.

## [2.1.0] - 2026-04-17

### Added

- **Intake clarification pipeline (core, mcp).** Universal interpret-and-confirm pipeline across all MCP routes. The MCP compiles every request into a `DraftTask`, attempts to interpret it into a concrete execution plan, and either executes immediately or returns a proposed interpretation for the caller to confirm. Iterative — drafts bounce back until the MCP is confident enough to commit.
- **`confirm_clarifications` MCP tool (mcp).** New route for resuming clarification sets. Accepts edited drafts with replace-whole semantics, re-evaluates through the intake pipeline, executes ready drafts, and bounces back unclear ones. Supports partial confirmation, round tracking, duplicate-reason detection, and 6 distinct error codes.
- **Route compilers (core).** Five route-specific compilers (`compileDelegateTasks`, `compileReviewCode`, `compileDebugTask`, `compileVerifyWork`, `compileAuditDocument`) that produce `DraftTask[]` with output-contract clauses, fan-out for multi-file routes, and source preservation.
- **Classification heuristic (core).** Deterministic classifier with three outcomes: `ready`, `needs_confirmation`, `unrecoverable`. Preset routes get content-quality checks (not structural checks). Confirmed drafts skip ambiguity criteria.
- **Clarification store (core).** In-memory TTL/LRU store for clarification sets with eager cleanup, round tracking, and per-draft lifecycle management.
- **`intakeProgress` on batch responses (mcp).** New field on all `delegate_tasks` responses showing `totalDrafts`, `readyDrafts`, `clarificationDrafts`, `hardErrorDrafts`, `executedDrafts`.
- **`clarifications` array on batch responses (mcp).** When tasks need confirmation, the response includes proposed interpretations with assumptions and questions.

### Changed

- **`schemaVersion` bumped to `2.1.0` (mcp).** All `delegate_tasks` responses now include `intakeProgress`. Responses with unclear tasks include `clarifications` and `clarificationId`.
- **Legacy normalizer removed (core).** The model-based `normalizeBrief()` call is replaced by a passthrough stub. Write-set derived from `filePaths`. The model call is fully removed; only the `NormalizationResult` shape remains for the review pipeline.
- **Readiness reduced to invariant check (core).** Tasks from the intake pipeline (`briefQualityPolicy: 'off'`) skip readiness entirely. Legacy readiness runs only for non-intake code paths during migration.

## [2.0.1] - 2026-04-16

### Fixed

- **`delegate_tasks` `done` field guidance corrected (core, mcp, docs).** The `done` field is a required acceptance-criteria signal, not a "prefer" hint — the readiness checker treats `TaskSpec.done` as satisfying the `done_condition` pillar. Three doc locations corrected: `packages/mcp/src/cli.ts:310` description, `packages/mcp/README.md:80` table entry, and `docs/claude-code-delegation-rule.md:55`.

## [2.0.0] - 2026-04-16

### Breaking Changes

- **`maxTurns` removed from config defaults (core).** Time and cost bounds replace turn limits. New defaults: `timeoutMs: 1_800_000` (30 min), `maxCostUSD: 10`.
- **`status: 'max_turns'` replaced by `'incomplete'` + `errorCode: 'degenerate_exhausted'` (core).** All runners emit structured incomplete statuses instead of a bare `max_turns` status.
- **TaskSpec stripped to task-signal fields (core).** Removed `maxTurns`, `skipCompletionHeuristic`, and internal fields from public surface. Added `done?: string` (acceptance criteria) and `filePaths?: string[]` (focus scope). `contextBlockIds` promoted to caller-facing.
- **MCP tool schemas simplified (mcp).** Specialized tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now expose only their domain fields + `filePaths`. Internal config fields (`cwd`, `tools`, `timeoutMs`, etc.) resolved by the harness from config, not caller-supplied. `applyCommonFields` removed.

### Changed

- **Prevention prompts now time/cost-based (core).** `buildBudgetHint` now takes `{ timeoutMs, maxCostUSD? }` instead of `{ maxTurns }`. `buildReGroundingMessage` takes `{ elapsedMs, timeoutMs, toolCallsSoFar, filesReadSoFar }` instead of `{ currentTurn, maxTurns, ... }`.
- **Supervision rewritten as monitor model (core).** Gatekeeper pattern replaced by monitor pattern. Loop detection and stall detection are advisory (inject re-grounding, don't terminate). `MAX_SUPERVISION_RETRIES` removed; `MAX_DEGENERATE_RETRIES = 10` governs retry budget. Only counts as degenerate when a turn has no tool calls.
- **`doneCondition` wired to `task.done` (core).** The spec reviewer prompt now shows the caller's acceptance criteria instead of hardcoded `'tsc passes'`. The worker's initial prompt also receives `task.done` as `## Success Criteria` so the worker itself is guided by the caller's acceptance criteria.
- **`briefQualityPolicy` transparent default is `normalize` (core).** Vague briefs are auto-normalized rather than surfaced with a warning. Previously defaulted to `'warn'` which surfaced vague briefs instead of normalizing them.
- **`review_rounds` transparent default is plateau detection (core).** Review continues until the reviewer approves, the same findings appear in two consecutive rounds, or the safety limit is reached. Previously hard-capped at `maxReviewRounds ?? 2` which was arbitrary.
- **`filePaths` is a soft completion signal (core).** Review is no longer skipped when `filesWritten` is empty. The harness tracks whether the worker read or wrote any `task.filePaths` and exposes it as `filePathsSkipped` in the result. Previously the review was skipped entirely when no files were written.
- **`retry_tasks` now re-injects fresh defaults (mcp).** Previously retried tasks ran with raw cached task specs. Now `retry_tasks` applies the same default injection as `delegate_tasks` (`tools`, `timeoutMs`, `maxCostUSD`, `sandboxPolicy`, `cwd`, `reviewPolicy`) so retries get current config values.

### Added

- **`done?: string` on TaskSpec (core, mcp).** Callers can specify acceptance criteria in plain language. Included in the worker's prompt as `## Success Criteria` and passed to the spec reviewer as `doneCondition`. Falls back to `'tsc passes'` when not provided.
- **`filePaths?: string[]` on TaskSpec (core, mcp).** Files the sub-agent should focus on. Used by specialized tools for prompt injection (`buildFilePathsPrompt`) and fan-out dispatch. The generic execution path tracks whether the worker interacted with these files as a soft completion concern (`filePathsSkipped` on `RunResult`).

## [1.3.0] - 2026-04-15

### Added
- **`no-shell` tool mode (core).** New `ToolMode` value `'no-shell'` enables all file tools (read, write, edit, grep, glob) while blocking shell access. Use for tasks with untrusted prompt content.
- **`TerminationReason` on `RunResult` (core).** Structured field reporting why a task stopped (`cause`), turn usage (`turnsUsed`/`turnsAllowed`), artifact evidence (`hasFileArtifacts`, `usedShell`), worker self-assessment, and whether status was promoted. Replaces the need to cross-reference multiple fields.
- **Shell usage guidance in worker system prompt (core).** Workers receive clear rules: use `run_shell` for tests, builds, and command-line tasks; use `edit_file`/`write_file` for file modifications; run targeted tests in parallel.

### Changed
- **`sandboxPolicy: 'cwd-only'` no longer blocks shell (core).** File tools remain confined to the cwd tree. Shell commands (`run_shell`) now execute freely under `cwd-only` — controlled by `tools` mode instead. Previously, `cwd-only` blocked both file paths and shell access. Callers who relied on shell blocking must switch to `tools: 'no-shell'`.
- **Completion detection redesign (core).** `FILE_MUTATING_TOOLS` renamed to `COMPLETED_WORK_TOOLS`, now includes `runShell`. `validateSubAgentOutput` accepts `workerStatus` and `hasCompletedWork` as explicit signals. `workerStatus: 'done'` with work evidence is trusted. Promotion logic recognizes shell-only tasks with substantive output.
- **`workerStatus` internalized (core, mcp).** Removed from MCP response surfaces (delegate_tasks, fan-out, metadata block, batch slice). Use `terminationReason.workerSelfAssessment` instead. Still available internally for escalation logic.
- **Field descriptions simplified (mcp).** All 15+ `buildTaskSchema()` field descriptions and 4 specialized tool descriptions rewritten. One-line-first pattern replaces verbose WHAT/WHEN/DEFAULT/INTERACTION format.
- **Worker system prompt rewritten for clarity (core).** Restructured into Tool rules, Shell rules, Progress and completion sections. All instructions are direct and unambiguous.

## [1.2.1] - 2026-04-14

### Added
- **`edit_file` steering in sub-agent system prompt (core).** Workers are now guided to prefer `edit_file` for partial modifications instead of `write_file` (full rewrite) or `run_shell` with sed/awk (error-prone). Added to the "Tool efficiency rules" section of `buildSystemPrompt()` in `prevention.ts`.
- **`maxCostUSD` on all specialized tools (mcp).** `audit_document`, `review_code`, `verify_work`, and `debug_task` now accept an optional `maxCostUSD` parameter, passed through to `runTasks()` via `commonToolFields` and `applyCommonFields()`. Callers can budget individual audits and reviews.
- **`escalationLog` and `agents` in single-task metadata (mcp).** `buildMetadataBlock()` now includes `escalationLog` (provider attempt chain) and `agents` (which agent ran each lifecycle role). Previously only available in fan-out mode via `buildFanOutResponse()`.

## [1.2.0] - 2026-04-13

### Added
- **`edit_file` tool for surgical edits (core).** New tool that replaces a unique string match in an existing file, wired into all three adapters (OpenAI, Claude, Codex). Requires `oldContent` to match exactly one location.
- **Effort inference from task prompt shape (core).** `inferEffort()` auto-selects effort level (`none`/`low`/`medium`/`high`) based on prompt characteristics when not explicitly declared.
- **Parallel-safe build instructions (core).** Concurrent tasks receive guidance to use targeted test commands instead of full-project builds.
- **Auto-retry transient errors (core).** `api_error`, `network_error`, and `timeout` statuses trigger automatic retry with exponential backoff (up to 2 retries).
- **`incomplete` → `ok` promotion (core).** When `workerStatus` is `done` and file artifacts exist, tasks are promoted from `incomplete` to `ok`.
- **`hasCompletedWork` flag (core).** Supervision skips stylistic heuristics (fragment, no-terminator) after file writes, reducing false-positive `incomplete` statuses.
- **Auto-skip review when no artifacts (core).** Review pipeline is skipped when the task produced no file artifacts, saving review budget.
- **Tool-use efficiency rules in system prompt (core).** Sub-agents receive guidance on avoiding redundant file reads, batching grep patterns, and preferring grep over readFile.

### Changed
- **Review status types (core).** `'not_run'` replaced with `'skipped'`/`'error'` for clearer semantics.
- **`retry_tasks`, `maxCostUSD`, and context block descriptions improved (mcp).** Clearer WHAT/WHEN/DEFAULT/INTERACTION documentation on MCP tool parameters.

## [1.1.0] - 2026-04-13

### Added
- **`readonly` tool mode (core).** New `ToolMode` value `'readonly'` enables read-only filesystem access (readFile, grep, glob, listFiles) while blocking writes and shell. Hosted tools (web_search, WebSearch/WebFetch) remain enabled in readonly mode. All three runners (OpenAI, Claude, Codex) and both adapters support readonly filtering.
- **Platform parity for specialized tools (mcp).** All 4 specialized tools (`audit_document`, `review_code`, `verify_work`, `debug_task`) now accept `filePaths`, `cwd`, `contextBlockIds`, and `tools` parameters. Each returns a metadata block with usage, status, files touched, and tool calls.
- **Fan-out parallel dispatch.** When specialized tools receive multiple `filePaths` without inline content, each file becomes a separate parallel task via `runTasks()`. Response uses a dedicated `fan_out` envelope (no batchId — not cache-backed).
- **`auditType` accepts array and `'general'`.** `audit_document` now accepts `['security', 'correctness']` or `'general'` (all four categories). `review_code` gains `outputFormat` parameter.
- **`verify_work` enforces `checklist.min(1)`.**
- **Shared tool infrastructure (mcp).** New internal modules: `shared.ts` (commonToolFields, dispatch logic, metadata builder, prompt helpers) and `batch-response.ts` (extracted from cli.ts).

### Changed
- **`delegate_tasks` description** now includes routing guidance for specialized tools.
- **`buildTaskSchema` tools enum** updated to `'none' | 'readonly' | 'full'`.
- **`debug_task` preset** now explicitly sets `reviewPolicy: 'full'` (was implicit via default).
- **Batch response builders** extracted from cli.ts into batch-response.ts. Re-exported from cli.ts for backward compatibility.

### Removed
- **`execute_plan_task` tool.** Subsumed by `delegate_tasks` with a single-element task array. Source, tests, registration, and package export all removed.

### Documentation
- **READMEs rewritten.** Marketing-first structure with savings table, quick start, collapsible details. MCP and core READMEs are complementary (no duplication).
- **Delegation rule rewritten.** Auto-pipeline for superpowers users (3 spec audit rounds, 2 plan audit rounds, automatic implementation + review). Standalone usage for non-superpowers users. 124 lines, imperative style.

## [1.0.0] - 2026-04-12

**Breaking rewrite from v0.4.0.** The config schema, tool surface, task fields, and lifecycle have all changed. See the migration table at the end of this entry.

### New Features

- **Reviewed lifecycle (core).** Every task now passes through a five-phase lifecycle: `Brief → Readiness check → Dispatch → Execute → Review (if enabled) → Aggregate`. The readiness check (`normalizeBrief`) evaluates prompt quality before any money is spent — it surfaces vague scopes, overambitious dispatches, and missing context before the worker runs.
- **Specialized tools (mcp).** Four tools beyond basic batch dispatch:
  - `audit_document` — verify a spec document's requirements are met
  - `debug_task` — triage a failure against known failure patterns
  - `review_code` — structural quality review of a diff or module
  - `verify_work` — confirm implementation matches spec
- **Two-slot agent model (core).** Tasks declare `agentType: "standard"` (fast, cheap, capability-gated) or `agentType: "complex"` (slower, reasoning) instead of `tier`. Auto-routing selects the cheapest configured agent satisfying the required capabilities and declared `agentType`.
- **Cost ceiling (core).** Each task can declare a `maxCostUSD` that aborts execution before spending beyond the threshold. Prevents runaway dispatches on ambiguous tasks.
- **Call cache (core).** Repeated identical calls (same prompt + model hash) return the cached result within a sliding window, avoiding redundant spend on retry paths.
- **Format constraints (core).** `expectedCoverage` declared per task enforces structured output requirements — `minSections`, `sectionPattern`, `requiredMarkers`. The supervision layer re-prompts on missing items and classifies thin responses as `insufficient_coverage`.
- **Structured errors (core).** Per-task status is now one of ten protocol values: `ok`, `incomplete`, `max_turns`, `timeout`, `api_aborted`, `api_error`, `network_error`, `error`, `brief_too_vague`, `cost_exceeded`. All ten surface the best-effort scratchpad into `output` before returning.
- **`schemaVersion` field (mcp).** Every response envelope carries `schemaVersion: "1.0.0"` so callers can branch on the schema shape without relying on version checks.

### Breaking Changes

- **`config.providers` → `config.agents`** (core). The top-level config key is now `agents`, reflecting the two-slot model. Provider entries inside `agents` use `provider` to name the underlying API type (`openai-compatible`, etc.).
- **`task.tier` → `task.agentType`** (core). `trivial`/`standard`/`reasoning` tiers are replaced by `agentType: "standard"` or `agentType: "complex"`. Standard maps roughly to `standard`; complex maps roughly to `reasoning`. `trivial` is now just `agentType: "standard"` with no special routing treatment.
- **`get_task_output`, `get_task_detail`, `get_batch_telemetry` → `get_batch_slice`** (mcp). Three fetch tools are consolidated into one. `get_batch_slice(batchId, slice)` where `slice` is `"output"`, `"detail"`, or `"telemetry"`.
- **`progressTrace` removed** (core). The bounded execution timeline capture is replaced by structured `AttemptRecord[]` entries in `get_batch_slice(..., "detail")`. `initialPromptHash` provides cross-runner stable identification of identical briefs.
- **`hostedTools` narrowed for `openai-compatible`** (core). Only `web_search` is available by default for openai-compatible providers. Other tools (`image_generation`, `code_interpreter`) require explicit opt-in.
- **`BatchAggregateCost` trimmed** (mcp). `actualCostUnavailableTasks` and `savedCostUnavailableTasks` are removed. The aggregate cost shape is now: `totalActualCostUSD`, `totalSavedCostUSD`.

### Migration: v0.4.0 → v1.0.0

| v0.4.0 | v1.0.0 | Notes |
|---|---|---|
| `config.providers` | `config.agents` | Config top-level key renamed |
| `task.tier: "trivial"\|"standard"\|"reasoning"` | `task.agentType: "standard"\|"complex"` | Tier replaced by two-slot agentType |
| `get_task_output(batchId, taskIndex)` | `get_batch_slice(batchId, "output", { taskIndex })` | Consolidated into one tool |
| `get_task_detail(batchId, taskIndex)` | `get_batch_slice(batchId, "detail", { taskIndex })` | Consolidated into one tool |
| `get_batch_telemetry(batchId)` | `get_batch_slice(batchId, "telemetry")` | Consolidated into one tool |
| `progressTrace` field | Removed | Use `get_batch_slice(..., "detail")` for `AttemptRecord[]` |
| `hostedTools: ["web_search", ...]` on openai-compatible | Only `web_search` available by default | Others require explicit opt-in |
| `BatchAggregateCost.actualCostUnavailableTasks` | Removed | — |
| `BatchAggregateCost.savedCostUnavailableTasks` | Removed | — |
| `delegate_tasks` with `responseMode: "full"` | `responseMode: "full"` unchanged | Full mode shape preserved |
| `delegate_tasks` with `responseMode: "summary"` | `responseMode: "summary"` unchanged | Summary shape preserved, but fetch tools consolidated |
| `tier: "reasoning"` + `effort: "high"` | `agentType: "complex"` | No effort change; agentType drives routing |
| `expectedCoverage` with `requiredMarkers` | `expectedCoverage` with `requiredMarkers` | Unchanged |
| `skipCompletionHeuristic` | `skipCompletionHeuristic` | Unchanged |
| `contextBlockIds` | `contextBlockIds` | Unchanged |
| `retry_tasks(batchId, taskIndices)` | `retry_tasks(batchId, taskIndices)` | Unchanged |
| `register_context_block(id, content)` | `register_context_block(id, content)` | Unchanged |

### New Tools Summary

| Tool | When to use it |
|---|---|
| `delegate_tasks` | Main batch dispatch; auto-routes to standard or complex slot |
| `register_context_block` | Store long briefs or evidence bundles once, reference by id |
| `retry_tasks` | Re-dispatch specific tasks from a batch |
| `get_batch_slice` | Fetch output/detail/telemetry from a previous batch |
| `audit_document` | Spec compliance audit |
| `debug_task` | Failure triage against known patterns |
| `review_code` | Structural code quality review |
| `verify_work` | Implementation vs spec verification |

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

[Unreleased]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.8.0...HEAD
[2.8.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.5...mcp-v2.8.0
[2.7.5]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.4...mcp-v2.7.5
[2.7.4]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.3...mcp-v2.7.4
[2.7.3]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.2...mcp-v2.7.3
[2.7.2]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.1...mcp-v2.7.2
[2.7.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.7.0...mcp-v2.7.1
[2.7.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.6.1...mcp-v2.7.0
[2.6.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.6.0...mcp-v2.6.1
[2.6.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.5.0...mcp-v2.6.0
[2.5.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.4...mcp-v2.5.0
[2.4.4]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.3...mcp-v2.4.4
[2.4.3]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.2...mcp-v2.4.3
[2.4.2]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.1...mcp-v2.4.2
[2.4.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.4.0...mcp-v2.4.1
[2.4.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.3.0...mcp-v2.4.0
[2.3.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.2.0...mcp-v2.3.0
[2.2.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.1.1...mcp-v2.2.0
[2.1.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.1.0...mcp-v2.1.1
[2.1.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.0.1...mcp-v2.1.0
[2.0.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v2.0.0...mcp-v2.0.1
[2.0.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.3.0...mcp-v2.0.0
[1.3.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.2.1...mcp-v1.3.0
[1.2.1]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.2.0...mcp-v1.2.1
[1.2.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.1.0...mcp-v1.2.0
[1.1.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v1.0.0...mcp-v1.1.0
[1.0.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v0.4.0...mcp-v1.0.0
[0.4.0]: https://github.com/zhixuan312/multi-model-agent/compare/mcp-v0.3.1...mcp-v0.4.0
[0.1.2]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zhixuan312/multi-model-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zhixuan312/multi-model-agent/releases/tag/v0.1.0