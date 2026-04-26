# multi-model-agent — Privacy & Telemetry

**Last updated:** 2026-04-26  •  **Schema version:** 1  •  **Code:** [types.ts](../packages/core/src/telemetry/types.ts) · [event-builder.ts](../packages/core/src/telemetry/event-builder.ts) · [queue.ts](../packages/server/src/telemetry/queue.ts) · [consent.ts](../packages/server/src/telemetry/consent.ts)

> **3.6.0 release note — local-only.** This release ships the telemetry instrumentation and CLI, but **does not upload anything over the network**. Even when you opt in (`mmagent telemetry enable`), events queue only to `~/.multi-model/telemetry-queue.ndjson` on your machine and can be inspected with `mmagent telemetry dump-queue`. The schema below describes what *would* be uploaded once the receiver service is deployed in a follow-up release. Until then, the truthful summary of "what leaves your machine" is: nothing.

## What we collect (client-submitted)

### Envelope (`UploadBatch`)

Every upload is a single JSON object with these top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | `1` (literal) | Schema version for forward compatibility |
| `install` | `InstallMetadata` | Per-install metadata (see below) |
| `events` | `TelemetryEvent[]` | 1–500 events per batch |

### Install metadata (`InstallMetadata`)

Sent once per batch, describing the install:

| Field | Type | Values / Constraints |
|-------|------|---------------------|
| `installId` | `string` (UUID) | Random UUIDv4, generated locally on first telemetry-eligible event |
| `mmagentVersion` | `string` | SemVer 2.0.0, max 64 chars (e.g. `3.6.0`) |
| `os` | `enum` | `darwin` \| `linux` \| `win32` \| `other` |
| `nodeMajor` | `string` | `"1"`–`"99"`, no leading zeros |
| `language` | `enum` | `en` \| `es` \| `fr` \| `de` \| `zh` \| `ja` \| `ko` \| `pt` \| `ru` \| `it` \| `tr` \| `ar` \| `hi` \| `vi` \| `id` \| `th` \| `pl` \| `nl` \| `sv` \| `other` |
| `tzOffsetBucket` | `enum` | `utc_minus_12_to_minus_6` \| `utc_minus_6_to_0` \| `utc_0_to_plus_6` \| `utc_plus_6_to_plus_12` \| `utc_plus_12_to_plus_15` |

### Event: `task.completed`

Emitted at the end of every task run (delegate, audit, review, verify, debug, execute-plan, retry).

| Field | Type | Values / Constraints |
|-------|------|---------------------|
| `type` | `literal` | `"task.completed"` |
| `eventId` | `string` (UUID) | Random UUIDv4 for idempotency dedup |
| `route` | `enum` | `delegate` \| `audit` \| `review` \| `verify` \| `debug` \| `execute-plan` \| `retry` |
| `agentType` | `enum` | `standard` \| `complex` |
| `capabilities` | `string[]` | Up to 2 unique values from: `web_search` \| `web_fetch` |
| `toolMode` | `enum` | `none` \| `readonly` \| `no-shell` \| `full` |
| `triggeredFromSkill` | `enum` | `mma-delegate` \| `mma-audit` \| `mma-review` \| `mma-verify` \| `mma-debug` \| `mma-execute-plan` \| `mma-retry` \| `mma-investigate` \| `mma-context-blocks` \| `mma-clarifications` \| `other` \| `direct` |
| `client` | `enum` | `claude-code` \| `cursor` \| `codex-cli` \| `gemini-cli` \| `other` |
| `fileCountBucket` | `enum` | `0` \| `1-5` \| `6-20` \| `21-50` \| `51+` |
| `durationBucket` | `enum` | `<10s` \| `10s-1m` \| `1m-5m` \| `5m-30m` \| `30m+` |
| `costBucket` | `enum` | `$0` \| `<$0.01` \| `$0.01-$0.10` \| `$0.10-$1` \| `$1+` |
| `savedCostBucket` | `enum` | `$0` \| `<$0.10` \| `$0.10-$1` \| `$1+` \| `unknown` |
| `implementerModelFamily` | `enum` | `claude` \| `openai` \| `gemini` \| `deepseek` \| `other` |
| `implementerModel` | `string` | Canonical model ID from known allowlist, or `other` |
| `terminalStatus` | `enum` | `ok` \| `incomplete` \| `timeout` \| `error` \| `cost_exceeded` \| `brief_too_vague` \| `unavailable` |
| `workerStatus` | `enum` | `done` \| `done_with_concerns` \| `needs_context` \| `blocked` \| `failed` \| `review_loop_aborted` |
| `errorCode` | `enum` \| `null` | `verify_command_error` \| `commit_metadata_invalid` \| `commit_metadata_repair_modified_files` \| `dirty_worktree` \| `diff_review_rejected` \| `runner_crash` \| `executor_error` \| `api_error` \| `network_error` \| `rate_limit_exceeded` \| `other` — `null` when `terminalStatus` is `ok` |
| `escalated` | `boolean` | True if more than one escalation step occurred |
| `fallbackTriggered` | `boolean` | True if any fallback model overrides were used |
| `topToolNames` | `string[]` | Top 5 distinct tool names by call count, allowlisted: `readFile` \| `writeFile` \| `editFile` \| `runShell` \| `listFiles` \| `grep` \| `glob` \| `other` |
| `stages` | `object` | Per-stage breakdown (see below) |

#### `stages` object

| Stage | Type | Extra Fields |
|-------|------|-------------|
| `stages.implementing` | `StageStats` | — |
| `stages.verifying` | `VerifyStageStats` | `outcome`, `skipReason` |
| `stages.spec_review` | `ReviewStageStats` | `verdict`, `roundsUsed`, `concernCategories` |
| `stages.spec_rework` | `StageStats` | — |
| `stages.quality_review` | `ReviewStageStats` | `verdict`, `roundsUsed`, `concernCategories` |
| `stages.quality_rework` | `StageStats` | — |
| `stages.diff_review` | `ReviewStageStats` (optional) | `verdict`, `roundsUsed`, `concernCategories` |
| `stages.committing` | `StageStats` | — |

#### `StageStats` base fields (shared by all stages)

| Field | Type | Values |
|-------|------|--------|
| `entered` | `boolean` | Whether the task entered this stage |
| `durationBucket` | `enum` \| `null` | `<10s` \| `10s-1m` \| `1m-5m` \| `5m-30m` \| `30m+` — null when `entered` is false |
| `costBucket` | `enum` \| `null` | `$0` \| `<$0.01` \| `$0.01-$0.10` \| `$0.10-$1` \| `$1+` — null when `entered` is false |
| `agentTier` | `enum` \| `null` | `standard` \| `complex` — null when `entered` is false |
| `modelFamily` | `enum` \| `null` | `claude` \| `openai` \| `gemini` \| `deepseek` \| `other` — null when `entered` is false |
| `model` | `string` \| `null` | Canonical model ID or `other` — null when `entered` is false |

#### `VerifyStageStats` extends `StageStats`

| Field | Type | Values |
|-------|------|--------|
| `outcome` | `enum` \| `null` | `passed` \| `failed` \| `skipped` \| `not_applicable` |
| `skipReason` | `enum` \| `null` | `no_command` \| `dirty_worktree` \| `not_applicable` \| `other` |

#### `ReviewStageStats` extends `StageStats`

| Field | Type | Values |
|-------|------|--------|
| `verdict` | `enum` \| `null` | `approved` \| `concerns` \| `changes_required` \| `error` \| `skipped` \| `not_applicable` |
| `roundsUsed` | `enum` \| `null` | `0` \| `1` \| `2+` |
| `concernCategories` | `string[]` \| `null` | Up to 9 values from: `missing_test` \| `scope_creep` \| `incomplete_impl` \| `style_lint` \| `security` \| `performance` \| `maintainability` \| `doc_gap` \| `other` |

### Event: `session.started`

Emitted once per server start when telemetry is enabled.

| Field | Type | Values / Constraints |
|-------|------|---------------------|
| `type` | `literal` | `"session.started"` |
| `eventId` | `string` (UUID) | Random UUIDv4 |
| `configFlavor.defaultTier` | `enum` | `standard` \| `complex` |
| `configFlavor.diagnosticsEnabled` | `boolean` | |
| `configFlavor.autoUpdateSkills` | `boolean` | |
| `providersConfigured` | `string[]` | Up to 3 unique values from: `claude` \| `openai-compatible` \| `codex` |

### Event: `install.changed`

Emitted when the mmagent version changes (install, upgrade, downgrade).

| Field | Type | Values / Constraints |
|-------|------|---------------------|
| `type` | `literal` | `"install.changed"` |
| `eventId` | `string` (UUID) | Random UUIDv4 |
| `fromVersion` | `string` \| `null` | SemVer 2.0.0, max 64 chars; null on fresh install |
| `toVersion` | `string` | SemVer 2.0.0, max 64 chars |
| `trigger` | `enum` | `fresh_install` \| `upgrade` \| `downgrade` |

### Event: `skill.installed`

Emitted when an mma-* skill is installed into a client.

| Field | Type | Values / Constraints |
|-------|------|---------------------|
| `type` | `literal` | `"skill.installed"` |
| `eventId` | `string` (UUID) | Random UUIDv4 |
| `skill` | `enum` | `mma-delegate` \| `mma-audit` \| `mma-review` \| `mma-verify` \| `mma-debug` \| `mma-execute-plan` \| `mma-retry` \| `mma-investigate` \| `mma-context-blocks` \| `mma-clarifications` \| `other` |
| `client` | `enum` | `claude-code` \| `cursor` \| `codex-cli` \| `gemini-cli` \| `other` |

### Validation rules (enforced by `.superRefine()`)

The following consistency rules are enforced on every `task.completed` event:

- **R1:** `terminalStatus: "ok"` requires `workerStatus` of `done` or `done_with_concerns`, and `errorCode` must be null.
- **R2:** `stages.verifying.outcome` must be null or `not_applicable` for non-verify routes (`audit`, `review`, `debug`, `retry`).
- **R3:** `stages.spec_review`, `stages.quality_review`, and `stages.diff_review` must have `entered: false` for non-reviewed routes (`audit`, `review`, `verify`, `debug`, `retry`).
- **R4:** When a stage has `entered: false`, all sub-fields must be null.
- **R5:** When a stage has `entered: true`, all base bucketed fields and stage-type-specific fields must be non-null; `skipReason` must be non-null when `outcome` is `skipped`.

## What we collect (server-side operational metadata)

The server stores additional fields not sent by the client:

- `received_at` — exact UTC timestamp when the upload arrived. Used for partition routing and aggregation date attribution.
- `event_id` — the random UUID generated by the client for idempotency dedup.
- `install_id` — the random UUID identifying your install (already disclosed in client metadata).
- `event_type` and `schema_version` — extracted from the event for indexing.
- `installs.first_seen_at` and `installs.last_seen_at` — exact UTC timestamps. Used for retention pruning and cohort calculations.
- Per-install rate-limit counters — held transiently in **Redis** (in-memory; TTL = the rate-limit window). Not written to Postgres in 3.6.0. If we later add a "biggest senders" abuse panel, a `install_event_counts_daily` table will be added and disclosed here at that time.

These fields are necessary for the system to function and are disclosed here as part of the contract.

## What we never collect

- Prompt text, prompt hashes, prompt lengths in characters or words
- File paths, file path hashes, file contents, directory names, repo names
- Worker outputs, error messages, stack traces
- Hostnames, machine names, exact client-side event timestamps
- Username, email, git author, git remote, branch name, commit message
- API keys, OAuth tokens, secrets of any kind
- Custom skill names — community/user skills are reported as `'other'` (the literal string)
- Custom model aliases — non-canonical model IDs are reported as `'other'`
- Raw locale strings — we collect only the 2-letter language code (e.g. `en`, `zh`); region/country dropped
- Anything that requires inspecting your prompts, your code, or your working directory

If you discover us collecting something not listed in "What we collect" above,
that is a bug. File an issue at the repository; we will treat it as a security incident.

## How IPs are handled

- IP addresses are processed transiently in **nginx memory only** for per-IP rate limiting (in-memory shared zone with TTL — no disk persistence).
- They are NOT written to access logs, NOT stored in the database, and NOT visible to the Fastify application.
- The Fastify app does NOT perform any IP-based rate limiting or IP fallback — all IP-based throttling is at the nginx tier.
- The application-level rate limit (Redis) is keyed only on `installId`.

## Pseudonymity statement

- The `installId` is a random UUIDv4 generated locally on first telemetry-eligible event.
- It is not linked to your IP, hostname, email, or any user identity.
- It is pseudonymous — capable of correlating multiple events from the same install — not anonymous in the strictest sense.
- You can regenerate it at any time with `mmagent telemetry reset-id`. We treat the new ID as a fresh install in our metrics.

## How long we keep it

- Raw events: **90 days**. Then dropped via partition drop.
- Per-install daily event counts (operational): **90 days**.
- Aggregated daily/weekly counts: **kept indefinitely** — no install ID, no path back to a person.
- Per-install metadata (`installs` table): kept while active; deleted after **365 days** with no activity.

## How to opt out

Three equivalent paths, resolved in this order:

1. **Environment variable:** Set `MMAGENT_TELEMETRY=0` (or `false`, `off`, `no`). Takes effect on next process start.
2. **Config file:** Set `"telemetry": { "enabled": false }` in `~/.multi-model/config.json`. Takes effect immediately (file-watch).
3. **CLI:** Run `mmagent telemetry disable`. Writes config + stops flusher + deletes queue. Effective <2 seconds.

Precedence: env var > config file > default. An unparseable env value fails closed (telemetry disabled). An unparseable config file fails closed.

**Default for 3.6.0:** disabled (opt-in). This is intentional for the internal-testing phase.

To opt in: set `MMAGENT_TELEMETRY=1`, or `"telemetry": { "enabled": true }` in config, or run `mmagent telemetry enable`.

## Our commitments

- Never sell, share, or expose this data to third parties (no ads, no analytics SaaS, no AI training).
- Never use this data to identify individuals or correlate behavior to a person.
- Never add a content-capturing field without bumping schema version + updating this doc + announcing in CHANGELOG.
- This page updates BEFORE any code change that alters what is collected.
- Public dashboard release is gated on a count-suppression layer (rows with `count < 5` are suppressed or grouped into `other`).

## Source code

- Builder (pure):  [packages/core/src/telemetry/event-builder.ts](../packages/core/src/telemetry/event-builder.ts)
- Schema:          [packages/core/src/telemetry/types.ts](../packages/core/src/telemetry/types.ts)
- Queue (I/O):     [packages/server/src/telemetry/queue.ts](../packages/server/src/telemetry/queue.ts)
- Consent:         [packages/server/src/telemetry/consent.ts](../packages/server/src/telemetry/consent.ts)

If the published schema and the code disagree, the code is the bug — please file an issue.
