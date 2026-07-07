---
name: mma-flow
description: Use when you want the packaged MMA-native design-to-merged-code flow that resumes from durable artifacts and optionally accelerates audit/review loops in Claude Code
when_to_use: You want one packaged SDLC playbook that starts at design, writes the spec and plan, builds on an mma/* branch, reviews the diff, verifies the repository, opens a PR, and merges only after the deferred-decision gate passes.
version: "0.0.0-unreleased"
---

# mma-flow

## Overview

`mma-flow` is the packaged SDLC orchestration playbook for MMA. It is not a server endpoint and it does not add server-side workflow state. The `SKILL.md` is the cross-client source of truth; Claude Code can optionally accelerate the repetitive loop stages with packaged workflow scripts.

## When to Use

**Use when:**
- You want the full MMA-native flow from design through merged pull request
- You need resume behavior from existing specs, plans, branches, and PR state
- You want Design to stay git-free and Build to happen on a dedicated `mma/<slug>` branch

**Do not use when:**
- You only need one lifecycle step such as `mma-design`, `mma-plan`, `mma-audit`, or `mma-review`
- You want a new task type or server endpoint; `mma-flow` is packaged skill orchestration only

## This is NOT an endpoint

`mma-flow` is a packaged orchestration skill. There is no `POST /task { "type": "flow" }`.

## Stage 0 LOCATE

Run LOCATE on every invocation. Determine the earliest incomplete coarse stage from durable evidence:

- `latestSpecPath`
- `latestPlanPath`
- whether the working directory is inside a git repository
- the detected source branch and project branch
- whether the project branch has unique commits
- whether a PR exists and whether it is merged
- whether the Deferred-Decision Ledger has unresolved items
- current-session evidence for clean review and whole-repo-green verification

Resume rules:

| Signal state | Resume stage |
|---|---|
| No spec under `docs/mma/specs/` | `D1` |
| Spec exists, no plan under `docs/mma/plans/` | `B1`, then `B2` |
| Plan exists, no `mma/*` branch | `B3`, then `B4` |
| `mma/*` branch exists, no commits beyond source branch | `B5` |
| `mma/*` branch has unique commits and no current-session clean review evidence | `B6` |
| Review passed in the current session and whole-repo green is not yet proven in the current session | `B7` |
| Whole-repo green is proven in the current session and no PR exists | `B8` |
| PR exists and is not merged | `B9` |
| PR merged | Flow complete |

If only session-local review or green evidence is missing after an interruption, fall back to the nearest safe durable gate: `B6` or `B7`.

## Design

Design is git-free.

1. `D1` — run `mma-design`
2. `D2` — run `mma-spec` and write the spec into `docs/mma/specs/`

Do not require git validation before Build begins.

## Build

Build requires git. Before `B1`, confirm the working directory is inside a git repository. If git is unavailable or the directory is not a git repository, stop before Build, explain the failure, and keep the Design artifacts intact.

1. `B1` — run the packaged `segment-spec-audit.js`
2. `B2` — run `mma-plan` and write the plan into `docs/mma/plans/`
3. `B3` — run the packaged `segment-plan-audit.js`
4. `B4` — create the project branch from the detected source branch
5. `B5` — run the packaged `segment-execute.js` on the project branch
6. `B6` — run the packaged `segment-review.js`
7. `B7` — run whole-repo verification on the project branch
8. `B8` — push the project branch and create the pull request
9. `B9` — evaluate the Deferred-Decision Ledger, merge automatically only if it is empty

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

```json
{
  "item": "what still needs a human decision",
  "assumptionMade": "what the flow assumed so work could continue",
  "blastRadius": "what could be affected if the assumption is wrong",
  "blockedWork": "what cannot finish until the decision is made"
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

Every supported client installs this playbook. Only Claude Code installs packaged workflow helpers. Gemini, Codex, and Cursor users follow the same stage order manually from this `SKILL.md`.
