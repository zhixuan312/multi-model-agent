# Privacy & Telemetry Policy

**Updated:** 2026-04-26 · **Schema version:** 1

multi-model-agent collects anonymous, low-cardinality usage statistics to help improve the product. This page documents every field that crosses the wire, every field we refuse to collect, and how to opt out.

**Default: off.** No events leave your machine unless you explicitly opt in.

## What we collect

Every uploaded event belongs to one of four types: `task.completed`, `session.started`, `install.changed`, or `skill.installed`. All fields are either pseudonymous, bucketed, derived, or public — no raw content ever crosses the wire.

### Install metadata (sent once per batch)

- **installId** — A random UUIDv4 generated locally on first telemetry-eligible event. Pseudonymous; rotates every 365 days. No link to your identity, hostname, or IP.
- **mmagentVersion** — The SemVer version of the CLI (e.g. `3.6.0`).
- **os** — OS family: `darwin`, `linux`, `win32`, or `other`.
- **nodeMajor** — Node.js major version (e.g. `22`).
- **language** — Two-letter language code derived from your locale (e.g. `en`, `zh`). Region and country are dropped. Unrecognized locales collapse to `other`.
- **tzOffsetBucket** — UTC offset mapped to one of five fixed 6-hour ranges.

### Task lifecycle events (`task.completed`)

Emitted at the end of every delegate, audit, review, verify, debug, execute-plan, and retry run.

- **route** — Which tool was used: `delegate`, `audit`, `review`, `verify`, `debug`, `execute-plan`, `retry`.
- **agentType** — `standard` or `complex`.
- **capabilities** — Whether `web_search` or `web_fetch` was used.
- **toolMode** — Tool access level: `none`, `readonly`, `no-shell`, or `full`.
- **triggeredFromSkill** — Which skill triggered the task, or `direct`.
- **client** — Which client invoked mmagent: `claude-code`, `cursor`, `codex-cli`, `gemini-cli`, or `other`.
- **fileCountBucket** — Number of files touched, bucketed into one of five ranges (`0`, `1-5`, `6-20`, `21-50`, `51+`). Never the actual count.
- **durationBucket** — Task duration, bucketed (`<10s`, `10s-1m`, `1m-5m`, `5m-30m`, `30m+`). Never the raw duration.
- **costBucket** — Task cost, bucketed (`$0`, `<$0.01`, `$0.01-$0.10`, `$0.10-$1`, `$1+`). Never the raw cost.
- **savedCostBucket** — Estimated cost saved vs. doing the work manually, bucketed.
- **implementerModelFamily** — Provider family: `claude`, `openai`, `gemini`, `deepseek`, or `other`.
- **implementerModel** — Canonical model ID from a known allowlist, or `other`. Custom model aliases are never sent.
- **terminalStatus** — How the task ended: `ok`, `incomplete`, `timeout`, `error`, `cost_exceeded`, `brief_too_vague`, `unavailable`.
- **workerStatus** — Worker outcome: `done`, `done_with_concerns`, `needs_context`, `blocked`, `failed`, `review_loop_aborted`.
- **errorCode** — Pre-defined error category (e.g. `api_error`, `network_error`, `verify_command_error`). Raw error messages and stack traces are **never** transmitted.
- **escalated** — Whether the task escalated to a more capable model.
- **fallbackTriggered** — Whether any fallback model overrides were used.
- **topToolNames** — Top 5 tool names by call count, from a fixed allowlist (`readFile`, `writeFile`, `editFile`, `runShell`, `listFiles`, `grep`, `glob`, `other`).
- **stages** — Per-stage breakdown (implementing, verifying, spec_review, spec_rework, quality_review, quality_rework, diff_review, committing). Each stage reports only structural data: whether it was entered, bucketed duration/cost, model family, and review verdicts/concerning categories. Stage-level verdicts use fixed enums (`approved`, `concerns`, `changes_required`, `error`, `skipped`, `not_applicable`). Concern categories likewise use fixed enums (`missing_test`, `scope_creep`, `incomplete_impl`, `style_lint`, `security`, `performance`, `maintainability`, `doc_gap`, `other`).

### Session and install events

- **session.started** — Emitted once per server start when telemetry is enabled. Records config defaults (tier, diagnostics, auto-update) and which providers are configured.
- **install.changed** — Emitted when the CLI version changes. Records `fromVersion`, `toVersion`, and trigger (`fresh_install`, `upgrade`, `downgrade`).
- **skill.installed** — Emitted when an mma-* skill is installed into a client. Records which skill and which client. Custom/community skill names are reported as `other`.

### How fields are classified

| Classification | Meaning |
|---|---|
| **Pseudonymous** | Anonymous but stable for the lifetime of the install ID (max 365 days). |
| **Bucketed** | The original value would be identifying; only the bucket label crosses the wire. |
| **Derived** | Mapped from user content (e.g. an error) into a fixed enum, irreversibly. |
| **Public** | The value is the same for everyone in that category; not identifying. |

Full technical schema with every field, enum value, and validation rule: [docs/PRIVACY.md](docs/PRIVACY.md).

## What we never collect

- **Identity:** Usernames, hostnames, real names, email addresses, IP addresses (IPs are processed ephemerally in nginx memory for rate limiting only — never written to access logs, never stored in the database).
- **Location:** File paths, directory names, project names, repo URLs, branch names, git remotes.
- **Content:** Source code, diffs, file contents, prompts, model outputs, conversation history, commit messages, commit SHAs.
- **Secrets:** API keys, OAuth tokens, environment variable values, credentials of any kind.
- **Diagnostics:** Stack traces, raw error messages (only enum error codes are sent), internal state dumps.
- **Free-form text:** No unbounded string fields exist in the schema. Every field is a typed enum, a bucket, or a constrained value. Adding one requires a schema change, a PRIVACY.md update, and a CHANGELOG entry.

If you discover us collecting something not listed in "What we collect," that is a bug. Please file an issue — we will treat it as a security incident.

## How to opt out

Telemetry is **disabled by default**. If you previously opted in:

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
| 2026-04-26 | 1 | Initial privacy policy. Document all `task.completed`, `session.started`, `install.changed`, and `skill.installed` fields. Enum-only, bucketed values only, no free-form text, no content capture. Telemetry off by default. |
