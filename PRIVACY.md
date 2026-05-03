# Privacy & Telemetry Policy

**Schema version: 4** · **Last revised:** 2026-05-03 — 3.12.2 (cost-attribution revamp)

multi-model-agent collects anonymous operational measurements to help improve the product. This page documents every field that crosses the wire, every field we refuse to collect, and how to opt out.

**Default: off.** No events leave your machine unless you explicitly opt in.

## What we collect

Every uploaded event is a single `task.completed` event. Install metadata travels with each batch wrapper; there are no separate session, install, or skill events.

### Task lifecycle event (`task.completed`)

Emitted at the end of every delegate, audit, review, verify, debug, execute-plan, investigate, and retry run. The event has 25 top-level scalar fields plus a `stages` array.

#### Identity (3 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `eventId` | UUIDv4 string | At-most-once dedup within the 90-day retention window |
| `route` | enum: `delegate`, `audit`, `review`, `verify`, `debug`, `execute-plan`, `retry`, `investigate` | Route distribution + per-route quality metrics |
| `client` | string (1–120 chars, alphanumeric + `-_.:+/@`) | Client adoption tracking |

#### Configuration (5 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `agentType` | enum: `standard`, `complex` | Tier distribution → model selection defaults |
| `toolMode` | enum: `none`, `readonly`, `no-shell`, `full` | Safety surface tracking |
| `capabilities` | string array: `web_search`, `web_fetch`, `other` | Feature usage → investment decisions |
| `reviewPolicy` | enum: `full`, `quality_only`, `diff_only`, `none` | Review topology distribution |
| `verifyCommandPresent` | boolean | Verify-command adoption rate |

#### Model (3 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `implementerModel` | string (1–120 chars) | Model usage distribution across the fleet |
| `implementerTier` | enum: `standard`, `complex`, `main` | Tier classification used as the reviewer-separation gate (the user's model choice is sovereign; tier is the mechanism). Cost accounting still keys off `implementerModel`. |
| `parentModel` | string (1–120 chars) or null | The flagship model the task was delegated FROM (e.g. `claude-opus-4-7`). Added in 3.12.2 alongside `parentModelFamily` so retrospective cost analysis doesn't have to assume the parent identity. Null for clients without a parent context (codex-cli, cursor). |

#### Outcome (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `terminalStatus` | enum: `ok`, `incomplete`, `timeout`, `error`, `cost_exceeded`, `brief_too_vague`, `unavailable` | Success/failure rate per route |
| `workerStatus` | enum: `done`, `done_with_concerns`, `needs_context`, `blocked`, `failed`, `review_loop_aborted` | Worker outcome quality |
| `errorCode` | enum or null — values include `verify_command_error`, `commit_metadata_invalid`, `commit_metadata_repair_modified_files`, `dirty_worktree`, `diff_review_rejected`, `runner_crash`, `executor_error`, `api_error`, `network_error`, `rate_limit_exceeded`, `incomplete_no_summary`, `reviewer_separation_unsatisfiable`, `other` | Failure attribution (no raw error messages). `incomplete_no_summary` and `reviewer_separation_unsatisfiable` were added in 3.12.1 to surface previously-silent failure modes. |
| `parentModelFamily` | enum: 33 model family values + `other` | Parent-model diversity tracking |

#### Token economics (5 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `inputTokens` | integer (0–5,000,000) | New (non-cached) input tokens. As of 3.12.2 schema v4: sibling semantics — `inputTokens` does NOT include cache reads or cache writes. |
| `outputTokens` | integer (0–500,000) | Total output token volume |
| `cachedReadTokens` | integer (0–5,000,000) | Cache-read token volume — billed at the cache-read rate (~10% of input). Replaces the prior `cachedTokens` field as of 3.12.2. |
| `cachedCreationTokens` | integer (0–5,000,000) | Cache-write/creation token volume — billed at the cache-creation rate (Anthropic: 1.25× input; other providers: no premium). Added in 3.12.2 to bill cache writes correctly. |
| `reasoningTokens` | integer (0–500,000) | Reasoning token volume (separate from output) |

#### Run totals (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `totalDurationMs` | integer (0–86,400,000) | Exact elapsed wall-clock time in milliseconds |
| `totalCostUSD` | float (0–800) or null | Token-times-pricing cost estimate in US dollars. Null when any contributing stage has unresolvable model pricing (honest-null discipline). |
| `parentEquivalentCostUSD` | float (0–800) or null | What the SAME tokens would have cost on the parent model. Null when `parentModel` is null or its pricing profile is unavailable. Added in 3.12.2. |
| `costDeltaVsParentUSD` | float (−800 to 800) or null | `totalCostUSD − parentEquivalentCostUSD`. Positive = worker cost more than parent. Negative = saved. Null when either contributing field is null. |

#### Per-tier rollup (`tierUsage`)

A keyed record `{ standard?, complex?, main? }` where each present tier carries the per-tier sum of all stage-level token counts and `costUSD`. Each tier's `costUSD` is the sum of stage costs at each stage's own model rate (so it's accurate even when fallback swapped models within a tier). Added in 3.12.2 to expose per-tier cost without iterating `stages[]`.

| Sub-field (per tier) | Type |
|---|---|
| `model` | string — the last model that ran on this tier within the task (forensic label; for accurate reverse-pricing iterate `stages[]`) |
| `inputTokens`, `outputTokens`, `cachedReadTokens`, `cachedCreationTokens`, `reasoningTokens` | integer — same semantics as the top-level token fields, restricted to stages on this tier |
| `costUSD` | float or null — sum of `stage.costUSD` for stages on this tier (null per honest-null if any contributing stage was null) |

#### Lifecycle counts (3 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `concernCount` | integer (0–150) | Review workload volume |
| `escalationCount` | integer (0–20) | Escalation frequency |
| `fallbackCount` | integer (0–20) | Provider-fallback frequency |

#### Operational signals (6 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `stallCount` | integer (0–20) | Stall-watchdog fire frequency → timeout tuning |
| `taskMaxIdleMs` | integer (0–1,200,000) | Longest silent gap in the task lifecycle → stall-threshold calibration. As of 3.12.1, never null on the wire (was `number \| null` previously); `0` means no measurable idle gap. |
| `clarificationRequested` | boolean | Clarification frequency |
| `briefQualityWarningCount` | integer (0–20) | Brief-quality warning rate |
| `sandboxViolationCount` | integer (0–100) | Sandbox-policy violation rate |
| `validation_warnings` | optional array of `{ rule: string, path: string }` | Cross-field schema-validation warnings (R1–R16) attached when the event triggers a refinement issue. **Meta about validation only — does NOT contain user data.** Each entry carries the rule name (e.g. `"R1: ..."`) and the Zod issue path (empty string for cross-field rules). Absent on healthy events. Backend uses this to quantify warning rates without re-running validation. |

#### Stages array (0–16 entries)

Each stage is a discriminated-union entry on `(name, round)`. As of 3.12.2 (schema v4), multi-round review/rework loops emit one entry per round (so `spec_review × 3` produces three entries with `round: 0, 1, 2`). The array max raised from 8 to 16 to accommodate worst-case multi-round runs. Base fields common to all stage types:

| Field | Type |
|-------|------|
| `name` | enum: `implementing`, `spec_review`, `spec_rework`, `quality_review`, `quality_rework`, `diff_review`, `verifying`, `committing` |
| `round` | integer (≥0) — 0-indexed round counter; 0 for single-invocation stages. Added in 3.12.2 schema v4. |
| `model` | string — the model used for this stage (cost-accounting label) |
| `tier` | enum: `standard`, `complex`, `main` — agent tier slot. Replaces the prior `agentTier` field as of 3.12.1; reviewer-separation now gates on tier, not model. |
| `durationMs` | integer — exact elapsed time for this stage |
| `costUSD` | float or null — cost estimate for this stage at this stage's own model rate; `null` when pricing is unavailable. |
| `inputTokens` | integer — sibling semantics (excludes cache) as of 3.12.2 schema v4. |
| `outputTokens` | integer |
| `cachedReadTokens` | integer or null — cache-read tokens. Replaces `cachedTokens` as of 3.12.2 schema v4. |
| `cachedCreationTokens` | integer or null — cache-write tokens. Added in 3.12.2 schema v4. |
| `reasoningTokens` | integer |
| `toolCallCount` | integer |
| `filesReadCount` | integer |
| `filesWrittenCount` | integer |
| `turnCount` | integer |
| `maxIdleMs` | integer (0–1,200,000) — longest silent gap in this stage. As of 3.12.1, never null on the wire (`0` means no measurable gap). |
| `totalIdleMs` | integer (0–3,600,000) — total idle time in this stage. As of 3.12.1, never null on the wire. |

Stage-type-specific extras:

- **Review stages** (`spec_review`, `quality_review`, `diff_review`): `verdict` (enum), `roundsUsed` (integer 1–10), `concernCategories` (string array — values from a closed enum: `missing_test`, `scope_creep`, `incomplete_impl`, `style_lint`, `security`, `performance`, `maintainability`, `doc_gap`, `doc_drift`, `contract_violation`, `coverage_gap`, `dead_code`, `queue_hygiene`, `other`), `findingsBySeverity` (`{ critical, high, medium, low }` object — counts of findings in each tier).
- **Rework stages** (`spec_rework`, `quality_rework`): `triggeringConcernCategories` (string array).
- **Verifying stage**: `outcome` (enum), `skipReason` (string or null).
- **Committing stage**: `filesCommittedCount` (integer), `branchCreated` (boolean).

### Batch wrapper (per-upload)

| Field | Type |
|-------|------|
| `schemaVersion` | integer literal `4` (was `3` pre-3.12.2). Backend dual-accepts `3` and `4` during the migration window. |
| `installId` | UUIDv4 — pseudonymous, generated locally, rotates every 365 days |
| `mmagentVersion` | SemVer string |
| `os` | enum: `darwin`, `linux`, `win32`, `other` |
| `nodeMajor` | integer 22–99 — Node.js major version |

No `language`, `tzOffsetBucket`, or `tzOffsetBucket` fields — these are no longer collected.

### How cost is computed

Cost is a token-times-pricing estimate from the daemon's pricing tables (`model-profiles.json`). It is NOT an invoice — actual charges may differ from the estimate.

As of 3.12.2 (schema v4), cost is computed via a single pure function `priceTokens(tokens, rateCard)` at every site (per-stage, per-turn meter, per-tier rollup, parent-equivalent). Each token class is multiplied by its own rate independently — there is no `(input − cached)` subtraction anywhere, so the prior subset-vs-sibling-semantics bug class is structurally impossible. The formula is:

```
cost =   inputTokens          × inputRate          (non-cached new input only)
       + outputTokens         × outputRate
       + cachedReadTokens     × cachedReadRate     (default: input × 0.10)
       + cachedCreationTokens × cachedCreationRate (Anthropic: input × 1.25; others: input)
       + reasoningTokens      × reasoningRate      (default: output)
```

Per-stage cost is computed at that stage's own model rate. The top-level `totalCostUSD` is the sum of per-stage costs (equivalently: the sum of `tierUsage[T].costUSD` across tiers).

`parentEquivalentCostUSD = priceTokens(allTokens, parentRateCard)` — the same totals priced at the parent model's rate. `costDeltaVsParentUSD = totalCostUSD − parentEquivalentCostUSD`. Positive = paid more than parent would have. Negative = saved. Both are null when `parentModel` is null or its pricing profile is unavailable. Like cost, all of these are estimates, not guarantees.

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
- **Model family fields:** No model family fields beyond the single `parentModelFamily` enum. The old per-stage `modelFamily` fields are removed.

If you discover us collecting something not listed in "What we collect," that is a bug. Please file an issue — we will treat it as a security incident.

## How to opt out

Telemetry is **disabled by default**. If you previously opted in to V2 telemetry:

- On upgrade to 3.10.0+, your V2 opt-in is cleared. You must explicitly opt in to V3 telemetry.
- Run `mmagent telemetry enable` to opt in. This writes both `telemetry.enabled = true` and `telemetryConsent.schemaVersion = 4` atomically.
- If you opted in to V3 and want to opt out:

```bash
# Option 1: CLI (immediate)
mmagent telemetry disable

# Option 2: Environment variable (takes effect next start)
export MMAGENT_TELEMETRY=0

# Option 3: Config file (immediate)
# Set "telemetry": { "enabled": false } in ~/.multi-model/config.json
```

To reset your pseudonymous identifier without disabling telemetry: `mmagent telemetry reset-id`.

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
| 2026-05-03 | 4 | V4 schema (cost-attribution revamp): `cachedTokens` split into `cachedReadTokens` + `cachedCreationTokens` everywhere — Anthropic cache writes now bill at 1.25× input correctly. Stage entries gain `round` (per-round telemetry for multi-round review/rework loops); `(name, round)` is the uniqueness key. Event root gains `tierUsage` (per-tier rollup), `parentModel` (specific identity alongside `parentModelFamily`), and `parentEquivalentCostUSD`. `inputTokens` switches to sibling semantics (excludes cache). Cost formula consolidates around a single `priceTokens` function — no subtraction anywhere. Backend dual-accepts schema v3 and v4. |
| 2026-04-29 | 3 | V3 schema: single `task.completed` event type; exact integer/numeric fields replace bucketed approximations; stages array replaces fixed-key stage map; `session.started`, `install.changed`, `skill.installed` event types removed; `topToolNames`, `triggeredFromSkill`, `workerSelfAssessment`, `c2Promoted` removed; `language`, `tzOffsetBucket` removed from batch wrapper; cost formula uses 4-term cached/reasoning rates; consent re-confirmation required on V2→V3 upgrade. |
| 2026-04-26 | 1 | Initial privacy policy. Document all `task.completed`, `session.started`, `install.changed`, and `skill.installed` fields. Enum-only, bucketed values only, no free-form text, no content capture. Telemetry off by default. |
