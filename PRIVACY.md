# Privacy & Telemetry Policy

**Schema version: 3** · **Last revised:** 2026-04-29 — 0.4.0 (3.10.0)

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

#### Model (1 field)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `implementerModel` | string (1–120 chars) | Model usage distribution across the fleet |

#### Outcome (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `terminalStatus` | enum: `ok`, `incomplete`, `timeout`, `error`, `cost_exceeded`, `brief_too_vague`, `unavailable` | Success/failure rate per route |
| `workerStatus` | enum: `done`, `done_with_concerns`, `needs_context`, `blocked`, `failed`, `review_loop_aborted` | Worker outcome quality |
| `errorCode` | enum or null | Failure attribution (no raw error messages) |
| `parentModelFamily` | enum: 33 model family values + `other` | Parent-model diversity tracking |

#### Token economics (4 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `inputTokens` | integer (0–5,000,000) | Total input token volume |
| `outputTokens` | integer (0–500,000) | Total output token volume |
| `cachedTokens` | integer (0–5,000,000) | Cache utilization rate |
| `reasoningTokens` | integer (0–500,000) | Reasoning token volume (subset of output) |

#### Run totals (3 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `totalDurationMs` | integer (0–86,400,000) | Exact elapsed wall-clock time in milliseconds |
| `totalCostUSD` | float (0–800) | Token-times-pricing cost estimate in US dollars |
| `totalSavedCostUSD` | float (−800 to 800) or null | Modeled counterfactual: cost if the task had been done by the parent model instead. Null when no parent pricing profile is available |

#### Lifecycle counts (3 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `concernCount` | integer (0–150) | Review workload volume |
| `escalationCount` | integer (0–20) | Escalation frequency |
| `fallbackCount` | integer (0–20) | Provider-fallback frequency |

#### Operational signals (5 fields)

| Field | Type | Decision driver |
|-------|------|-----------------|
| `stallCount` | integer (0–20) | Stall-watchdog fire frequency → timeout tuning |
| `taskMaxIdleMs` | integer (0–1,200,000) or null | Longest silent gap in the task lifecycle → stall-threshold calibration |
| `clarificationRequested` | boolean | Clarification frequency |
| `briefQualityWarningCount` | integer (0–20) | Brief-quality warning rate |
| `sandboxViolationCount` | integer (0–100) | Sandbox-policy violation rate |

#### Stages array (0–8 entries)

Each stage is a discriminated-union entry on `name`. The base fields common to all stage types:

| Field | Type |
|-------|------|
| `name` | enum: `implementing`, `spec_review`, `spec_rework`, `quality_review`, `quality_rework`, `diff_review`, `verifying`, `committing` |
| `model` | string — the model used for this stage |
| `agentTier` | enum: `standard`, `reasoning` |
| `durationMs` | integer — exact elapsed time for this stage |
| `costUSD` | float — cost estimate for this stage |
| `inputTokens` | integer |
| `outputTokens` | integer |
| `cachedTokens` | integer |
| `reasoningTokens` | integer |
| `toolCallCount` | integer |
| `filesReadCount` | integer |
| `filesWrittenCount` | integer |
| `turnCount` | integer |
| `maxIdleMs` | integer or null — longest silent gap in this stage |
| `totalIdleMs` | integer or null — total idle time in this stage |

Stage-type-specific extras:

- **Review stages** (`spec_review`, `quality_review`, `diff_review`): `verdict` (enum), `roundsUsed` (integer 1–10), `concernCategories` (string array), `findingsBySeverity` (`{ high, medium, low, style }` object).
- **Rework stages** (`spec_rework`, `quality_rework`): `triggeringConcernCategories` (string array).
- **Verifying stage**: `outcome` (enum), `skipReason` (string or null).
- **Committing stage**: `filesCommittedCount` (integer), `branchCreated` (boolean).

### Batch wrapper (per-upload)

| Field | Type |
|-------|------|
| `schemaVersion` | integer literal `3` |
| `installId` | UUIDv4 — pseudonymous, generated locally, rotates every 365 days |
| `mmagentVersion` | SemVer string |
| `os` | enum: `darwin`, `linux`, `win32`, `other` |
| `nodeMajor` | integer 22–99 — Node.js major version |

No `language`, `tzOffsetBucket`, or `tzOffsetBucket` fields — these are no longer collected.

### How cost is computed

Cost is a token-times-pricing estimate from the daemon's pricing tables (`model-profiles.json`). It is NOT an invoice — actual charges may differ from the estimate. The formula is:

```
cost = (inputTokens - cachedTokens) × inputRate
     + cachedTokens × cachedInputRate
     + (outputTokens - reasoningTokens) × outputRate
     + reasoningTokens × reasoningRate
```

Cached input tokens are priced at the profile's cache rate (defaulting to 10% of the input rate per Anthropic's published pricing). Reasoning tokens are a subset of output tokens and are priced at the profile's reasoning rate (defaulting to the output rate — no surcharge).

`totalSavedCostUSD` is a modeled counterfactual: what the same token profile would have cost if run with the orchestrator's parent model instead of the implementer model that was actually used. Like cost, it is an estimate, not a guarantee.

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
- Run `mmagent telemetry enable` to opt in. This writes both `telemetry.enabled = true` and `telemetryConsent.schemaVersion = 3` atomically.
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
| 2026-04-29 | 3 | V3 schema: single `task.completed` event type; exact integer/numeric fields replace bucketed approximations; stages array replaces fixed-key stage map; `session.started`, `install.changed`, `skill.installed` event types removed; `topToolNames`, `triggeredFromSkill`, `workerSelfAssessment`, `c2Promoted` removed; `language`, `tzOffsetBucket` removed from batch wrapper; cost formula uses 4-term cached/reasoning rates; consent re-confirmation required on V2→V3 upgrade. |
| 2026-04-26 | 1 | Initial privacy policy. Document all `task.completed`, `session.started`, `install.changed`, and `skill.installed` fields. Enum-only, bucketed values only, no free-form text, no content capture. Telemetry off by default. |
