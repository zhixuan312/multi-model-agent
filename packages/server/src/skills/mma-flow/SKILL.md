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
  | 'B9'
  | 'B10';

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
| PR merged, no journal entries recorded this session | `B10` |
| PR merged, journal entries recorded this session | Flow complete |

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
10. `B10` — synthesize and record journal entries from the entire flow

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

`B1`, `B3`, and `B6` all use the same policy. The gate for advancing to the next stage is a **clean pass** — a single round whose own findings contain **0 critical AND 0 high**. Applying fixes never satisfies the gate on its own; only a subsequent pass that itself comes back clean does. A round that found any high (even with 0 critical) is never a stopping point, no matter how thoroughly its findings were fixed.

1. Run the relevant MMA worker.
2. Count the critical and high findings **in that pass**.
3. If both counts are zero, that pass is clean — stop the loop and advance.
4. Otherwise — any critical, OR any high, including the "0 critical, ≥1 high" case — dispatch a fix worker for every critical/high finding, then **run another full round**. Never advance on the strength of the fixes alone: a round that surfaced highs must be followed by a fresh round that surfaces none.
5. Cap the loop at three rounds.
6. If critical or high findings remain after round three, return `proceed: false` and stop the flow before the next stage.

**Worked example.** Round 1 returns 0 critical, 2 high. You fix both highs. You may NOT skip to the next stage — a pass with highs was never clean. Run round 2. If round 2 returns 0 critical / 0 high, that clean pass is the gate: advance. If round 2 still has a high (a fix was incomplete or introduced a new issue), fix again and run round 3. This applies identically to spec audit (B1), plan audit (B3), and code review (B6).

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

## B10 — Journal record (knowledge capture)

After merge, synthesize learnings from the entire flow (D1 through B9) and record them via `mma-journal-record`. This is the knowledge-capture gate — it turns ephemeral session context into durable team knowledge.

### What to capture and what to skip

The journal already holds the team's **known knowns** — things clearly documented, previously decided, or trivially derivable from the codebase. B10 does NOT re-record those. Instead it targets two categories of knowledge that only surface *during* a flow cycle:

**Known unknowns → now resolved.** Gaps we knew existed but filled during this flow. These surface when the flow crosses a system boundary or brings in external information:

- External research (D1/mma-explore) revealed an industry practice, ecosystem constraint, or prior-art pattern we hadn't incorporated
- User input during spec interview (D1/mma-design) clarified an integration point, external system behavior, or business rule that was previously assumed or unknown
- Investigation during planning (B2) discovered codebase state (actual signatures, existing patterns, undocumented constraints) that contradicted or refined the spec's assumptions
- Audit findings (B1/B3) exposed ambiguity or contradiction that required a decision — the decision itself is the resolved unknown

**Unknown knowns → now articulated.** Tacit understanding that became explicit through iteration. These surface when the flow forces precision on something previously vague:

- Product direction that crystallized during the design interview — the user's preferences, priorities, or constraints that weren't stated upfront but emerged through Q&A
- Style/convention patterns that became clear only when the reviewer or auditor flagged inconsistency — the team "knew" the convention but had never written it down
- Process learnings from the flow itself — what worked, what didn't, what gate or step surfaced a problem that would have been missed

### How to extract

Walk the flow artifacts in order and extract learnings:

| Flow stage | Where to look | What surfaces |
|---|---|---|
| D1 (design) | mma-explore results, mma-design interview transcript | Research findings not previously known; user decisions that resolved ambiguity; directions explored and dropped (with why) |
| D2 (spec) | The spec file itself; diff between early drafts and final | Requirements that changed shape during iteration; constraints discovered late |
| B1 (spec audit) | Audit findings and fixes | Ambiguities that weren't obvious until audited; assumptions that were wrong |
| B2 (plan) | The plan file; any plan-vs-codebase reconciliation notes | Codebase state that surprised the planner; symbols/paths that didn't exist as assumed |
| B3 (plan audit) | Audit findings and fixes | Cross-task dependencies or sequencing issues discovered; verification commands that needed adjustment |
| B5 (execute) | Worker reports; inline fixes; deferred ledger entries | Implementation surprises — things that worked differently than the plan assumed; workarounds applied |
| B6 (review) | Review findings | Code patterns flagged as inconsistent with existing conventions; edge cases the plan missed |
| B7 (verification) | Test/build failures fixed | Pre-existing issues surfaced; integration points that broke unexpectedly |
| B9 (ledger) | Deferred decisions and their resolutions | Every resolved ledger entry is a known-unknown that was filled — record the resolution, not just the decision |

### Recording

Compose a single `mma-journal-record` prompt per learning. Each entry must be concrete — not "we learned about auth" but "Discovered that the OAuth provider returns `expires_at` as Unix seconds, not milliseconds; our token-refresh logic assumed ms. Reconciled in task I-4." Map each to one of the 6 journal types:

| Journal type | Maps to |
|---|---|
| `decision` | A direction chosen and alternatives dropped — especially directions explored in D1 and rejected with evidence |
| `design` | Architecture or pattern rationale that emerged during the flow — why the structure ended up this way, not just what it is |
| `behavior` | User preferences, communication style, or workflow habits observed during the design interview or ledger resolution |
| `process` | What worked or failed in the SDLC flow itself — which gates caught real issues, which steps were wasteful, what sequencing matters |
| `knowledge` | External facts, API behaviors, ecosystem constraints, or research findings discovered during investigate/research/explore |
| `style` | Naming, documentation, code pattern, or convention norms that were implicit and are now explicit |

### Rules

- **Skip known knowns.** If the learning is already in the journal (run `mma-journal-recall` with a quick probe if unsure), do not re-record it. If it *refines* an existing node, the worker will issue a `refine` operation.
- **Focus on #2 and #3.** Every entry should answer: "What did we not know (or not articulate) before this flow started, that we now know?" If the answer is "nothing new here," skip it.
- **One entry per insight, not per stage.** A single flow might produce 2–8 journal entries, or zero for a trivial change. Don't pad.
- **Concrete over abstract.** Include the specific file, API, behavior, or decision — not a vague category label.
- **B10 never blocks.** If `mma-journal-record` fails, log the failure and report it, but do not roll back the merge or halt the flow. The code is already landed; knowledge capture is best-effort.

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
