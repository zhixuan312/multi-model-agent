# Privacy & Telemetry Policy

**Schema version: 5** · **Last revised:** 2026-05-18 — 4.7.7 (wire-record honesty pass: `verifyCommandPresent` + `validationsRun` removed, `reviewPolicy` reframed as per-task intent, `errorCode` preserved through seal)

multi-model-agent collects anonymous operational measurements to help improve the product. This page documents every field that crosses the wire, every field we refuse to collect, and how to opt out.

**Default: off.** No events leave your machine unless you explicitly opt in.

## What we collect

Every uploaded event is a single `task.completed` event. Install metadata travels with each batch wrapper; there are no separate session, install, or skill events.

### Task lifecycle event (`task.completed`)

Emitted at the end of every delegate, audit, review, verify, debug, execute-plan, investigate, research, journal-record, journal-recall, retry, and register-context-block run. The event has 27 top-level scalar fields plus a `stages` array.

#### Identity (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `eventId` | UUIDv4 string | At-most-once dedup within the 90-day retention window |
| `route` | enum: `delegate`, `audit`, `review`, `verify`, `debug`, `execute-plan`, `retry`, `investigate`, `research`, `journal-record`, `journal-recall`, `register-context-block` | Route distribution + per-route quality metrics |
| `subtype` | string (1–64 chars) or null | Finer-grained route tag for read-only routes — e.g. `audit:plan`, `debug:isolated_test`, `audit:security`, `audit:performance`. Null on routes that don't expose a subtype variant. Added in 4.5.0; the field landed on the HTTP envelope in 4.4.0 but didn't reach telemetry until 4.5.0. |
| `client` | string (1–120 chars, alphanumeric + `-_.:+/@`) | Client adoption tracking |

#### Configuration (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `agentType` | enum: `standard`, `complex` | Tier distribution → model selection defaults |
| `toolMode` | enum: `none`, `readonly`, `no-shell`, `full` | Safety surface tracking |
| `capabilities` | string array: `web_search`, `web_fetch`, `other` | Feature usage → investment decisions |
| `reviewPolicy` | The per-task review policy that was requested. One of `full`, `quality_only`, `diff_only`, `none`. This is intent, not outcome — whether review actually ran is captured in `stages.review.outcome`. |

#### Model (3 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `implementerModel` | string (1–120 chars) | Model usage distribution across the fleet |
| `implementerTier` | enum: `standard`, `complex`, `main` | Tier classification used as the reviewer-separation gate (the user's model choice is sovereign; tier is the mechanism). Cost accounting still keys off `implementerModel`. |
| `mainModel` | string (1–120 chars) or null | The flagship model the task was delegated FROM (e.g. `claude-opus-4-7`). Added in 3.12.2 alongside `mainModelFamily` so retrospective cost analysis doesn't have to assume the main agent identity. Null for clients without a main agent context (codex-cli, cursor). |

#### Outcome (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `terminalStatus` | enum: `ok`, `incomplete`, `timeout`, `error`, `cost_exceeded`, `brief_too_vague`, `unavailable` | Success/failure rate per route |
| `workerStatus` | enum: `done`, `done_with_concerns`, `needs_context`, `blocked`, `failed`, `review_loop_aborted` | Worker outcome quality |
| `errorCode` | enum or null — values include `verify_command_error`, `commit_metadata_invalid`, `commit_metadata_repair_modified_files`, `dirty_worktree`, `diff_review_rejected`, `runner_crash`, `executor_error`, `api_error`, `network_error`, `rate_limit_exceeded`, `incomplete_no_summary`, `reviewer_separation_unsatisfiable`, `other` | Failure attribution (no raw error messages). `incomplete_no_summary` and `reviewer_separation_unsatisfiable` were added in 3.12.1 to surface previously-silent failure modes. |
| `mainModelFamily` | enum: 33 model family values + `other` | Parent-model diversity tracking |

**Note on completion semantics (4.7.8+):** `terminal_status` and `worker_status` are derived from objective lifecycle signals — review verdict, commit-gate outcome, rework state, and per-stage `implement.outcome`. Worker self-assessment (whether the sub-agent said it was "done" or "failed") is recorded in the wire record for telemetry analytics but does NOT gate completion. A worker that says "failed" because it couldn't run verification, but whose code was approved by the reviewer and committed, will still record `terminal_status='ok'` / `worker_status='done'`.

#### Token economics (5 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `inputTokens` | integer (0–5,000,000) | New (non-cached) input tokens. As of 3.12.2 schema v4: sibling semantics — `inputTokens` does NOT include cache reads or cache writes. |
| `outputTokens` | integer (0–500,000) | Total output token volume |
| `cachedReadTokens` | integer (0–5,000,000) | Cache-read token volume — billed at the cache-read rate (~10% of input). Replaces the prior `cachedTokens` field as of 3.12.2. |
| `cachedNonReadTokens` | integer (0–5,000,000) | Cache-creation (non-read) token volume — billed at the cache-write rate (1.25× input for Anthropic; = input for most others). |

#### Run totals (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `totalDurationMs` | integer (0–86,400,000) | Exact elapsed wall-clock time in milliseconds |
| `totalCostUSD` | float (0–800) or null | Token-times-pricing cost estimate in US dollars. Null when any contributing stage has unresolvable model pricing (honest-null discipline). |
| `mainCostUSD` | float (0–800) or null | What the SAME tokens would have cost on the main model. Null when `mainModel` is null or its pricing profile is unavailable. Added in 3.12.2 as `mainEquivalentCostUSD`; renamed to `mainCostUSD` in 4.7.6 to match the DB column `main_cost_usd`. |
| `costDeltaVsMainUSD` | float (−800 to 800) or null | `totalCostUSD − mainCostUSD`. Positive = worker cost more than parent. Negative = saved. Null when either contributing field is null. |

#### Per-tier rollup (`tierUsage`)

A keyed record `{ standard?, complex?, main? }` where each present tier carries the per-tier sum of all stage-level token counts and `costUSD`. Each tier's `costUSD` is the sum of stage costs at each stage's own model rate (so it's accurate even when fallback swapped models within a tier). Added in 3.12.2 to expose per-tier cost without iterating `stages[]`.

| Sub-field (per tier) | Type |
|---|---|
| `model` | string — the last model that ran on this tier within the task (forensic label; for accurate reverse-pricing iterate `stages[]`) |
| `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedNonReadTokens` | integer — same semantics as the top-level token fields, restricted to stages on this tier |
| `costUSD` | float or null — sum of `stage.costUSD` for stages on this tier (null per honest-null if any contributing stage was null) |

#### Lifecycle counts (3 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `concernCount` | integer (0–150) | Review workload volume |
| `escalationCount` | integer (0–20) | Escalation frequency |
| `fallbackCount` | integer (0–20) | Provider-fallback frequency |

#### Findings rollup (5 fields, as of 4.7.4)

Single top-level source of truth for findings-summary signals. Previously these were scattered across per-stage rows (review stage carried `findingsBySeverity`; implementing / review / annotating stages carried the outcome quartet). 4.7.4 lifts them to the top level; per-stage rows no longer carry duplicates. **Same data — only the JSON path moved.** No new collection.

| Field | Type | Decision driver |
|-------|------|-----------------|
| `findingsBySeverity` | object `{ critical, high, medium, low }` — non-negative integer count per severity tier of the task's final findings list (sum across implementer + reviewer findings, post-dedupe) | Severity-mix analytics. **Relocated from per-stage review row in 4.7.4.** |
| `findingsOutcome` | enum or null: `found`, `clean`, `not_applicable` — the task's final findings outcome rolled up across stages with priority review > annotating > implementing | Outcome distribution per route/tier |
| `findingsOutcomeReason` | string or null — short reason text the worker emitted alongside the outcome (e.g. when `not_applicable`, why). String is bounded by the worker's emission and the parser's slice; never contains user code or evidence text. | Outcome-reason categorization |
| `outcomeInferred` | boolean — `false` when the worker emitted an explicit `## Outcome` section the parser recognized; `true` when the parser inferred it from finding presence. | Worker-emission-quality signal — distinguishes "worker said so" from "parser fell back" |
| `outcomeMalformed` | boolean — `true` when the worker emitted a `## Outcome` section but with a value the parser couldn't parse | Worker-emission-quality signal |

#### Files (1 field)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `filesWrittenCount` | integer (0–5,000) | Number of files written during the task. As of 4.5.0, sourced from the real git diff (`git diff --name-only <preTaskHeadSha>` + filtered untracked-file delta) rather than the worker's self-reported `filesChanged`. No file paths or contents are transmitted — only the count. Eliminates the prior failure mode where a worker self-reporting `filesChanged: []` under-counted real artifacts. |

#### Operational signals (6 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `stallCount` | integer (0–20) | Stall-watchdog fire frequency → timeout tuning |
| `taskMaxIdleMs` | integer (0–1,200,000) | Longest silent gap in the task lifecycle → stall-threshold calibration. As of 3.12.1, never null on the wire (was `number \| null` previously); `0` means no measurable idle gap. |
| `clarificationRequested` | boolean | Clarification frequency |
| `briefQualityWarningCount` | integer (0–20) | Brief-quality warning rate |
| `sandboxViolationCount` | integer (0–100) | Sandbox-policy violation rate |
| `validation_warnings` | optional array of `{ rule: string, path: string }` | Validation warnings from two producers: (1) **Zod cross-field schema validation (R1–R16)** — `rule` is the rule name (e.g. `"R1: ..."`), `path` is the Zod issue path (empty string for cross-field rules); (2) **Findings-parser drops (4.7.5+)** — `rule` is `"findings_parser_drop"`, `path` is `"<reason>:<heading>"` where reason is one of `empty_claim` / `missing_core_bullet` / `invalid_severity` / `invalid_evidence_format` and `heading` is the literal `Finding N: <title>` text the worker emitted (truncated to 120 chars). The heading slice may contain a fragment of the worker's output (the finding title only) so a worker that put sensitive content in a Finding title would leak that fragment here. Backend uses this to quantify warning rates without re-running validation. Absent on healthy events. |

#### Stages array (0–16 entries)

Each stage is a discriminated-union entry on `(name, round)`. As of 4.3.1 (schema v5), the stage vocabulary collapses to five names: `implementing`, `review` (combined spec + quality sub-reviewers, one entry per round), `rework` (single combined pass), `annotating`, `committing`. The `round` field still distinguishes per-round entries; the array max remains 16. Base fields common to all stage types:

| Field | Type |
|-------|------|
| `name` | enum: `implementing`, `review`, `rework`, `annotating`, `committing` |
| `round` | integer (≥0) — 0-indexed round counter; 0 for single-invocation stages. Added in 3.12.2 schema v4. |
| `model` | string — the model used for this stage (cost-accounting label) |
| `tier` | enum: `standard`, `complex`, `main` — agent tier slot. Replaces the prior `agentTier` field as of 3.12.1; reviewer-separation now gates on tier, not model. |
| `durationMs` | integer — exact elapsed time for this stage |
| `costUSD` | float or null — cost estimate for this stage at this stage's own model rate; `null` when pricing is unavailable. |
| `mainCostUSD` | float or null — what THIS stage's tokens would have cost at the main model's rate. Null when `mainModel` is null or its pricing profile is unavailable. Added in 4.5.0 as `mainEquivalentCostUSD` so per-model savings can be sliced per stage without re-running rate-card math on the consumer side; renamed to `mainCostUSD` in 4.7.6 to match the DB column `main_cost_usd`. |
| `inputTokens` | integer — sibling semantics (excludes cache) as of 3.12.2 schema v4. |
| `outputTokens` | integer |
| `cachedReadTokens` | integer or null — cache-read tokens. Replaces `cachedTokens` as of 3.12.2 schema v4. |
| `cachedNonReadTokens` | integer or null — cache-creation (non-read) tokens. Formerly `cachedCreationTokens`. |
| `toolCallCount` | integer |
| `filesReadCount` | integer |
| `filesWrittenCount` | integer |
| `turnCount` | integer |
| `maxIdleMs` | integer (0–1,200,000) — longest silent gap in this stage. As of 3.12.1, never null on the wire (`0` means no measurable gap). |
| `totalIdleMs` | integer (0–3,600,000) — total idle time in this stage. As of 3.12.1, never null on the wire. |

Stage-type-specific extras:

- **Review stage** (`review`): `verdict` (enum), `roundsUsed` (integer 1–10), `concernCategories` (string array — values from a closed enum: `missing_test`, `scope_creep`, `incomplete_impl`, `style_lint`, `security`, `performance`, `maintainability`, `doc_gap`, `doc_drift`, `contract_violation`, `coverage_gap`, `dead_code`, `queue_hygiene`, `other`). Combines spec + quality sub-reviewers under one entry per round. As of 4.7.4, `findingsBySeverity` is no longer carried on the review stage row — it lives at the top level (see "Findings rollup" above).
- **Rework stage** (`rework`): `triggeringConcernCategories` (string array). Single combined pass replacing the prior `spec_rework` / `quality_rework` split.
- **Annotating stage** (`annotating`): `outcome` (enum: `passed`, `failed`, `skipped`, `not_applicable`, `transformed`), `skipReason` (enum or null: `no_command`, `dirty_worktree`, `not_applicable`, `other`). Renamed from `verifying`. `transformed` was added in 4.5.0 to mark pure-transform annotating passes (no LLM call) so the per-stage emission shape stays consistent with the other stages and per-stage dashboards stop showing a gap.
- **Committing stage** (`committing`): `filesCommittedCount` (integer), `branchCreated` (boolean).

### Batch wrapper (per-upload)

| Field | Type |
|-------|------|
| `schemaVersion` | integer literal `5` (was `4` pre-4.3.1). mma is forward-only on the new vocabulary; the backend normalises legacy v4 records on read. |
| `installId` | UUIDv4 — pseudonymous, generated locally, rotates every 365 days |
| `mmaVersion` | SemVer string |
| `os` | enum: `darwin`, `linux`, `win32`, `other` |
| `nodeMajor` | integer 22–99 — Node.js major version |

No `language`, `tzOffsetBucket`, or `tzOffsetBucket` fields — these are no longer collected.

### How cost is computed

Cost is a token-times-pricing estimate from the daemon's pricing tables (`model-profiles.json`). It is NOT an invoice — actual charges may differ from the estimate.

Since 3.12.2 (schema v4), cost is computed via a single pure function `priceTokens(tokens, rateCard)` at every site (per-stage, per-turn meter, per-tier rollup, parent-equivalent). Each token class is multiplied by its own rate independently — there is no `(input − cached)` subtraction anywhere, so the prior subset-vs-sibling-semantics bug class is structurally impossible. The formula is:

```
cost =   inputTokens          × inputRate          (non-cached new input only)
       + outputTokens         × outputRate
       + cachedReadTokens     × cachedReadRate     (default: input × 0.10)
       + cachedNonReadTokens  × cachedNonReadRate  (Anthropic: input × 1.25; others: input)
```

Per-stage cost is computed at that stage's own model rate. The top-level `totalCostUSD` is the sum of per-stage costs (equivalently: the sum of `tierUsage[T].costUSD` across tiers).

`mainCostUSD = priceTokens(allTokens, parentRateCard)` — the same totals priced at the main model's rate. `costDeltaVsMainUSD = totalCostUSD − mainCostUSD`. Positive = paid more than parent would have. Negative = saved. Both are null when `mainModel` is null or its pricing profile is unavailable. Like cost, all of these are estimates, not guarantees.

### About durations

Durations are elapsed time measured via `performance.now()` (monotonic clock). No wall-clock timestamps cross the wire — the server's `received_at` is server-set for retention partitioning only, not client time. The monotonic clock excludes system suspend time, so durations reflect active work time, not calendar time.

## How fields are classified

| Classification | Meaning |
|---|---|
| **Pseudonymous** | Anonymous but stable for the lifetime of the install ID (max 365 days). |
| **Bucketed** | The original value would be identifying; only the bucket label crosses the wire. |
| **Derived** | Mapped from user content (e.g. an error) into a fixed enum, irreversibly. |
| **Public** | The value is the same for everyone in that category; not identifying. |
| **Operational** | Exact integer or numeric measurements of work performed (durations in ms, costs in USD, counts of tool calls, files, turns, tokens). No wall-clock times, no identities, no content. |

Full technical schema with every field, enum value, and validation rule: [docs/PRIVACY.md](docs/PRIVACY.md).

## What we never collect

- **Identity:** Usernames, hostnames, real names, email addresses, IP addresses (IPs are processed ephemerally in nginx memory for rate limiting only — never written to access logs, never stored in the database).
- **Location:** File paths, directory names, project names, repo URLs, branch names, git remotes.
- **Content:** Source code, diffs, file contents, prompts, model outputs, conversation history, commit messages, commit SHAs.
- **Secrets:** API keys, OAuth tokens, environment variable values, credentials of any kind.
- **Diagnostics:** Stack traces, raw error messages (only enum error codes are sent), internal state dumps.
- **Free-form text:** No unbounded string fields exist in the schema. Every field is a typed enum, a bucket, or a constrained value. Adding one requires a schema change, a PRIVACY.md update, and a CHANGELOG entry.
- **Timestamps:** No wall-clock timestamps — only monotonic-clock durations. The server's `received_at` is server-set for retention partitioning.
- **Tool names:** The `topToolNames` field from V2 has been removed. Tool-call counts are aggregated per stage but individual tool names are not transmitted.
- **Model family fields:** No model family fields beyond the single `mainModelFamily` enum. The old per-stage `modelFamily` fields are removed.

If you discover us collecting something not listed in "What we collect," that is a bug. Please file an issue — we will treat it as a security incident.

## Local-only data: `.mma/` directory

Starting in 4.0.3, the daemon writes context blocks (worker-output snippets used by round-over-round audit recipes) to disk under `<projectCwd>/.mma/context-blocks/<id>.txt` so they survive daemon restarts. This data:

- **Stays local.** Never uploaded to telemetry. Never leaves your machine.
- **Has restrictive permissions.** Directory `0700`, files `0600`. User-only access.
- **Has a 7-day TTL** (configurable). Expired entries are deleted on next access or via periodic GC.
- **Is size-capped.** 1 MiB per block, 100 MiB per project on disk. Oldest-first eviction beyond the cap.
- **Should be in `.gitignore`.** Context blocks contain worker output (which can contain code excerpts and audit findings). On first creation of `.mma/` in a project, the daemon prints a stderr breadcrumb suggesting you add `.mma/` to that project's `.gitignore`. The daemon does NOT auto-edit your `.gitignore` — that decision is yours.

Delete the `.mma/` directory at any time to wipe local context blocks.

## How to opt out

Telemetry is **disabled by default**. Run `mma telemetry enable` to opt in — this writes both `telemetry.enabled = true` and `telemetryConsent.schemaVersion = 5` atomically. To opt out:

```bash
# Option 1: CLI (immediate)
mma telemetry disable

# Option 2: Environment variable (takes effect next start)
export MMAGENT_TELEMETRY=0

# Option 3: Config file (immediate)
# Set "telemetry": { "enabled": false } in ~/.multi-model/config.json
```

To reset your pseudonymous identifier without disabling telemetry: `mma telemetry reset-id`.

## How long we keep data

- Raw events: **90 days** (partition drop).
- Aggregated daily/weekly counts: **indefinitely** (no install ID, no path back to a person).
- Per-install metadata: deleted after **365 days** with no activity.

## Our commitments

- Never sell, share, or expose this data to third parties (no ads, no analytics SaaS, no AI training).
- Never use this data to identify individuals or correlate behavior to a person.
- Never add a content-capturing field without bumping the schema version, updating this document, and announcing in the CHANGELOG.
- This page updates **before** any code change that alters what is collected.

## Changelog

| Date | Schema | Change |
|---|---|---|
| 2026-05-18 | 5 | Wire-record honesty pass (4.7.7 release). **Removed:** `verifyCommandPresent` (boolean) — the verify-command feature was deleted end-to-end, so the adoption signal is no longer collected; backend column `verify_command_present` remains nullable and accepts null for new records (no migration required). **Removed:** `validationsRun` byproduct field — inert plumbing that carried no signal. **Semantic redefinition** of `reviewPolicy` — same enum (`full` / `quality_only` / `diff_only` / `none`) but now sourced from per-task `TaskEnvelope.reviewPolicy` populated at envelope construction from the caller's per-task intent, no longer a server default. The wire `review_policy` column is now complementary to `stages.review.outcome` — intent vs what actually ran. An intent=`full` + outcome=`skipped` row is now a legitimate queryable signal rather than the apparent contradiction it used to be. **New invariant** on `errorCode`: the field was always nullable on the wire schema, but `recordTaskCompletedHandler` now preserves `errorCode` through seal so reviewer-rejection rows land `review_quality_findings_unresolved` or `review_spec_rejected_terminal` instead of `null`; previously `terminal_status=error + error_code=null` was indistinguishable from a transport failure. No new content collected; no schema version bump (bumping would silently drop queued v5 records via `flusher.ts:143`). |
| 2026-05-18 | 5 | Wire field rename (4.7.6 release): `mainEquivalentCostUSD` → `mainCostUSD` at top-level AND on every stage. Same semantic ("what these tokens would have cost at the main model's rate"); renamed for column-parity with `events_raw.main_cost_usd`. Also restores the per-stage and top-level compute that was accidentally dropped to `null` in 4.7.2's envelope-unification refactor — every v4.7.2–v4.7.5 event was emitting the field as `null`, collapsing per-model savings attribution. Backend dual-accepts both wire names during the daemon-restart transition. No new content collected. |
| 2026-05-18 | 5 | Additive within v5 (4.7.4 release). Top-level findings rollup: `findingsBySeverity` (relocated from per-stage review row), `findingsOutcome` (enum), `findingsOutcomeReason` (string), `outcomeInferred` (bool), `outcomeMalformed` (bool). Same data the review stage previously carried, lifted to top-level so all routes (not just routes that ran the review stage) contribute. Backend reads top-level; per-stage rows no longer carry these. No new content collected. |
| 2026-05-13 | 5 | Additive within v5 (4.5.0 release). Top-level: `subtype` (string \| null, finer-grained tag for read-only routes — e.g. `audit:plan`, `debug:isolated_test`) and `filesWrittenCount` (integer, count only — sourced from real git diff via sub-project A, not worker self-report). Stage base: `mainEquivalentCostUSD` (float \| null, per-stage main-model-equivalent cost). Annotating-stage `outcome` enum gains `transformed` for pure-transform passes. No new content collected, no schema version bump — counts/labels only. |
| 2026-05-11 | 5 | V5 schema (stage vocabulary collapse): eight legacy stage names fold into five — `spec_review` + `quality_review` + `diff_review` → `review`; `spec_rework` + `quality_rework` → `rework`; `verifying` → `annotating`; `implementing` and `committing` unchanged. Stage-specific extras unchanged (review keeps `verdict` / `roundsUsed` / `concernCategories` / `findingsBySeverity`; rework keeps `triggeringConcernCategories`; annotating keeps `outcome` / `skipReason`). No new fields, no new collection — pure rename. mma emits v5 only; backend normalises legacy v4 records on read. |
| 2026-05-03 | 4 | V4 schema (cost-attribution revamp): `cachedTokens` split into `cachedReadTokens` + `cachedNonReadTokens` everywhere — Anthropic cache writes now bill at 1.25× input correctly. Stage entries gain `round` (per-round telemetry for multi-round review/rework loops); `(name, round)` is the uniqueness key. Event root gains `tierUsage` (per-tier rollup), `mainModel` (specific identity alongside `mainModelFamily`), and `mainEquivalentCostUSD`. `inputTokens` switches to sibling semantics (excludes cache). Cost formula consolidates around a single `priceTokens` function — no subtraction anywhere. Backend dual-accepts schema v3 and v4. |
| 2026-04-29 | 3 | V3 schema: single `task.completed` event type; exact integer/numeric fields replace bucketed approximations; stages array replaces fixed-key stage map; `session.started`, `install.changed`, `skill.installed` event types removed; `topToolNames`, `triggeredFromSkill`, `workerSelfAssessment`, `c2Promoted` removed; `language`, `tzOffsetBucket` removed from batch wrapper; cost formula uses 4-term cached/reasoning rates; consent re-confirmation required on V2→V3 upgrade. |
| 2026-04-26 | 1 | Initial privacy policy. Document all `task.completed`, `session.started`, `install.changed`, and `skill.installed` fields. Enum-only, bucketed values only, no free-form text, no content capture. Telemetry off by default. |
