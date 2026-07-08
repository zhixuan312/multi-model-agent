---
name: mma-flow
description: "Claude Code command: /mma-flow — MMA-native design-to-merged-code SDLC playbook that resumes from durable artifacts"
when_to_use: "User explicitly invokes /mma-flow. This is a Claude Code command, not an auto-matched skill."
version: "0.0.0-unreleased"
---

# /mma-flow

This is a **Claude Code command**. The user invokes it by typing `/mma-flow`.

## Overview

`/mma-flow` is the packaged SDLC orchestration command for MMA. It is not a server endpoint and it does not add server-side workflow state. This file is the source of truth; the main agent drives all loop stages (audit→fix→re-audit) inline via the mma-* skill tools.

## When to Use

The user types `/mma-flow` when they want the full MMA-native flow from design through merged pull request. Stage 0 LOCATE auto-detects the current position from durable artifacts on disk and resumes from the earliest incomplete stage.

## This is NOT an endpoint or a skill

`/mma-flow` is a Claude Code command installed to `~/.claude/commands/mma-flow.md`. There is no `POST /task { "type": "flow" }`. It is not auto-matched by intent — the user must explicitly invoke it. Other clients (Codex, Gemini, Cursor) do not support this command; they use the individual `mma-*` skills directly.

## Stage 0 LOCATE

Run LOCATE on every invocation. Determine the earliest incomplete coarse stage from durable evidence:

```ts
type FlowStage =
  | 'D1'
  | 'D2'
  | 'B1'
  | 'B2'
  | 'B3'
  | 'B4'
  | 'B5'
  | 'B6'
  | 'B7'
  | 'B8'
  | 'B9';

interface LocateSignals {
  latestSpecPath?: string | null;
  latestPlanPath?: string | null;
  ledgerPath?: string | null;
  gitRepoPresent: boolean;
  sourceBranch?: string | null;
  projectBranch?: string | null;
  projectBranchHasUniqueCommits: boolean;
  prExists: boolean;
  prMerged: boolean;
  deferredDecisionLedgerHasItems: boolean;
  hasWritableGitHubRemote: boolean;
  currentSessionEvidence: {
    reviewPassed: boolean;
    wholeRepoGreen: boolean;
  };
}
```

Resume rules:

| Signal state | Resume stage |
|---|---|
| No spec under `docs/mma/specs/` | `D1` |
| Spec exists, no plan under `docs/mma/plans/` | `B1`, then `B2` |
| Plan exists, no `mma/*` branch | `B3`, then `B4` |
| `mma/*` branch exists, no commits beyond source branch | `B5` |
| `mma/*` branch has unique commits and no current-session clean review evidence | `B6` |
| Review passed in the current session and whole-repo green is not yet proven in the current session | `B7` |
| Whole-repo green is proven in the current session, no PR exists, and writable GitHub remote is available | `B8` |
| Whole-repo green is proven in the current session, no PR exists, and writable GitHub remote is unavailable | Stop after `B7`; report that PR automation requires a writable GitHub remote and leave branch intact |
| PR exists and is not merged | `B9` |
| PR merged | Flow complete |

**Multi-artifact disambiguation.** If multiple spec or plan files exist under the default artifact roots, LOCATE shall use the pair explicitly referenced in the current conversation. If no explicit reference exists, LOCATE shall choose the most recently modified spec under `docs/mma/specs/` and the most recently modified plan under `docs/mma/plans/` whose filename slug matches that spec's slug.

The rationale for the current-session evidence requirement is architectural: with no new server endpoint and no new persisted orchestration state, the skill can durably infer artifact and git boundaries, while audit and verification sub-steps remain session-local unless and until they produce the next durable artifact boundary.

If only session-local review or green evidence is missing after an interruption, fall back to the nearest safe durable gate: `B6` or `B7`.

## Design

Design is git-free.

1. `D1` — run `mma-design`
2. `D2` — run `mma-spec` and write the spec into `docs/mma/specs/`

Do not require git validation before Build begins.

## Build

Build requires git. Before `B1`, confirm the working directory is inside a git repository. If git is unavailable or the directory is not a git repository, stop before Build, explain the failure, and keep the Design artifacts intact.

1. `B1` — run `mma-audit` (subtype: spec) in a loop (audit→fix→re-audit, cap 3)
2. `B2` — run `mma-plan` and write the plan into `docs/mma/plans/`
3. `B3` — run `mma-audit` (subtype: plan) in a loop (audit→fix→re-audit, cap 3)
4. `B4` — create the project branch from the detected source branch
5. `B5` — run `mma-execute-plan` on the project branch
6. `B6` — run `mma-review` on changed files
7. `B7` — run whole-repo verification on the project branch
8. `B8` — verify PR prerequisites, push the project branch, and create the pull request
9. `B9` — evaluate the Deferred-Decision Ledger, merge automatically only if it is empty

### B1 — Ledger initialization

At `B1`, create the Deferred-Decision Ledger file at `docs/mma/ledgers/YYYY-MM-DD-<slug>.json` with an empty `entries` array and commit it to the project branch. The file must also record `sourceBranch` (the branch detected at `B4` or the current branch if `B4` has not yet run) and the `slug`, `specPath`, and `planPath` so later stages can read them without re-deriving.

### B7 — Whole-repo verification command discovery

Discover repository verification commands in this order:

1. If the user explicitly provided a verification command in the current conversation, use it.
2. Otherwise, detect the repository's build and test commands from its configuration files (`package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, etc.) and run the standard build-then-test sequence.
3. If no authoritative verification command can be identified, stop and ask the user before claiming whole-repo green.

### B8 — Pre-PR prerequisites

Before pushing or creating a PR, verify all three prerequisites:

1. The repository has a writable remote named `origin` pointing to a GitHub-hosted repository.
2. The `gh` CLI is installed and authenticated (`gh auth status` succeeds).
3. The `sourceBranch` still exists on the remote (`git ls-remote origin <sourceBranch>` returns a ref).

If any prerequisite fails, stop after `B7`, report which prerequisite failed, and leave the project branch intact for manual push and PR creation.

## Branch And PR Rules

Derive the branch slug from the spec title by:

1. lowercasing
2. converting every non-alphanumeric run to `-`
3. collapsing repeated `-`
4. trimming leading and trailing `-`
5. truncating to `30` characters
6. falling back to `task` if the truncated slug would be empty

Use:

```bash
sourceBranch=$(git rev-parse --abbrev-ref HEAD)
git checkout -b "mma/<slug>"
git push -u origin "mma/<slug>"
gh pr create --base "$sourceBranch" --head "mma/<slug>"
gh pr merge <number> --merge
```

The PR title must be `build(<slug>): <one-line spec summary>`.

Create the PR only after `B7` passes in the current session.

## Audit And Review Loop Policy

`B1`, `B3`, and `B6` all use the same policy:

1. Run the relevant MMA worker.
2. Count critical and high findings.
3. Stop immediately when both counts are zero.
4. If critical or high findings remain, and autofix is enabled, dispatch a fix worker and rerun.
5. Cap the loop at three rounds.
6. If critical or high findings remain after round three, return `proceed: false` and stop the flow before the next stage.

## Deferred-Decision Ledger

Track unresolved human decisions across `B1` through `B9` with entries shaped as:

```ts
export interface DeferredDecisionLedgerEntry {
  item: string;
  assumptionMade: string;
  blastRadius: string;
  blockedWork: string;
}
```

At `B9`:
- If the ledger is empty, auto-merge.
- If the ledger has entries, present them to the user, wait for decisions, apply any required branch changes, and merge only after the gate is cleared.

## Failure Handling

- If Design has not produced a spec yet, stop in `D1`.
- If Build starts outside a git repository, stop before `B1`.
- If `mma/<slug>` already exists and matches the active flow, switch to it and rerun LOCATE.
- If the branch name collides with a different in-progress flow, stop and ask the user to resolve the collision.
- If `gh` is unavailable or unauthenticated at `B8`, stop after `B7` and keep the branch intact for manual recovery.
- If `gh pr merge` fails at `B9`, leave the PR open and keep the branch.

## Client Portability

Every supported client installs this playbook. All clients follow the same stage order from this `SKILL.md`.

## Data Model

The flow uses three artifact families:

1. **Spec artifacts**

```text
docs/mma/specs/YYYY-MM-DD-<slug>.md
```

2. **Plan artifacts**

```text
docs/mma/plans/YYYY-MM-DD-<slug>.md
```

3. **Deferred-Decision Ledger artifacts**

```text
docs/mma/ledgers/YYYY-MM-DD-<slug>.json
```

Created at `B1` as an empty `entries` array with `sourceBranch`, `slug`, `specPath`, and `planPath` metadata. Committed to the project branch. Appended to by subsequent stages. Read by `B9` to determine whether human decisions are required before merge.

No new server-side schema, task type, or HTTP route is introduced.
