---
name: mma-flow
description: "Claude Code command: /mma-flow — MMA-native design-to-merged-code SDLC playbook that resumes from durable artifacts"
when_to_use: "User explicitly invokes /mma-flow. This is a Claude Code command, not an auto-matched skill."
version: "0.0.0-unreleased"
---

# /mma-flow

This is a **Claude Code command**. The user invokes it by typing `/mma-flow`.

## Overview

`/mma-flow` is the packaged SDLC orchestration command for MMA. It is not a server endpoint and it does not add server-side workflow state. This file is the source of truth. The main agent drives the loop stages: it dispatches the *audit/review* pass to an mma-* worker, but it **applies every fix itself, inline, with `Edit`** — it does not dispatch a fix worker (see "Applying fixes — inline, never dispatched").

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
  | 'D3'
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
  latestExplorationPath?: string | null;
  latestSpecPath?: string | null;
  latestPlanPath?: string | null;
  backlogPath?: string | null;
  gitRepoPresent: boolean;
  sourceBranch?: string | null;
  projectBranch?: string | null;
  projectBranchHasUniqueCommits: boolean;
  prExists: boolean;
  prMerged: boolean;
  deferredDecisionBacklogHasItems: boolean;
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
| No spec under `.mma/specs/` AND no exploration under `.mma/explorations/` | `D1` |
| Exploration exists under `.mma/explorations/`, no spec under `.mma/specs/` | `D2`, then `D3` |
| Spec exists, no plan under `.mma/plans/` | `B1`, then `B2` |
| Plan exists, no `mma/*` branch | `B3`, then `B4` |
| `mma/*` branch exists, no commits beyond source branch | `B5` |
| `mma/*` branch has unique commits and no current-session clean review evidence | `B6` |
| Review passed in the current session and whole-repo green is not yet proven in the current session | `B7` |
| Whole-repo green is proven in the current session, no PR exists, and writable GitHub remote is available | `B8` |
| Whole-repo green is proven in the current session, no PR exists, and writable GitHub remote is unavailable | Stop after `B7`; report that PR automation requires a writable GitHub remote and leave branch intact |
| PR exists and is not merged | `B9` |
| PR merged, no journal entries recorded this session | `B10` |
| PR merged, journal entries recorded this session | Flow complete |

**Multi-artifact disambiguation.** If multiple exploration, spec, or plan files exist under the default artifact roots, LOCATE shall use the set explicitly referenced in the current conversation. If no explicit reference exists, LOCATE shall choose the most recently modified spec under `.mma/specs/` and the most recently modified plan under `.mma/plans/` whose filename slug matches that spec's slug; the exploration is resolved as the most recently modified file under `.mma/explorations/` whose slug matches, and it is only consulted when no spec exists yet (once a spec exists, Design is complete and the exploration is not re-derived).

The rationale for the current-session evidence requirement is architectural: with no new server endpoint and no new persisted orchestration state, the skill can durably infer artifact and git boundaries, while audit and verification sub-steps remain session-local unless and until they produce the next durable artifact boundary.

If only session-local review or green evidence is missing after an interruption, fall back to the nearest safe durable gate: `B6` or `B7`.

## Design

Design is git-free.

1. `D1` — run `mma-explore`: capture the braindump, fan out investigate + research + journal-recall, synthesise, and write the exploration into `.mma/explorations/`.
2. `D2` — run `mma-brainstorm`: grill the requirements into confirmed decisions, consuming the latest `.mma/explorations/` artifact as grounding.
3. `D3` — run `mma-spec`: pass the confirmed decisions as the **first** `target.paths` file (scaffolded to a tmp file) and the `exploration.md` as the **second** (grounding); the worker writes the spec into `.mma/specs/`.

**In flow mode, `D3` owns the spec dispatch.** `mma-brainstorm` in isolation ends at confirmed decisions and *soft-offers* `mma-spec`; inside `/mma-flow` that soft offer is bypassed — the flow proceeds from `D2` straight into `D3`, which dispatches `mma-spec` exactly once. Do not dispatch the spec twice.

Do not require git validation before Build begins.

## Build

Build requires git. Before `B1`, confirm the working directory is inside a git repository. If git is unavailable or the directory is not a git repository, stop before Build, explain the failure, and keep the Design artifacts intact.

1. `B1` — run `mma-audit` (subtype: spec) in a loop (audit→fix→re-audit) under the escalating gate, hard cap 5
2. `B2` — run `mma-plan` and write the plan into `.mma/plans/`
3. `B3` — run `mma-audit` (subtype: plan) in a loop (audit→fix→re-audit) under the escalating gate, hard cap 5
4. `B4` — create the project branch from the detected source branch
5. `B5` — run `mma-execute-plan` on the project branch
6. `B6` — run `mma-review` on changed files in a loop under the escalating gate, hard cap 5
7. `B7` — run whole-repo verification on the project branch
8. `B8` — verify PR prerequisites, push the project branch, and create the pull request
9. `B9` — merge the PR automatically and unconditionally (the backlog never gates the merge)
10. `B10` — synthesize and record journal entries, then surface the backlog to the user as the terminal report

## Input model — structured files forward, unstructured prompt

Every stage that produces a durable artifact writes it under `.mma/` **so the next stage can receive it as a file** — that is the whole reason these files exist: they are the structured hand-off between stages. Each downstream dispatch therefore carries **two kinds of input, deliberately**:

- **Structured input → `target.paths` (files).** The durable upstream artifact(s) the stage consumes — `exploration.md` into spec, `spec.md` into plan, `plan.md` into execute. When a stage takes more than one file, the **first path is authoritative** and the rest are grounding/reference (spec receives `[decisions, exploration.md]`; the worker never treats the grounding file's options as decisions).
- **Unstructured input → `prompt`.** Only what is fresh to this stage — a title, extra constraints, task headings. Never re-paste a file that is already passed as a path.

| Stage | Structured file(s) in `target.paths` | `prompt` carries | Artifact written |
|---|---|---|---|
| `D1` explore | — (braindump only) | the braindump, per leg | `.mma/explorations/<slug>.md` |
| `D2` brainstorm | reads `exploration.md` (main agent) | the interview | confirmed decisions (in-context) |
| `D3` spec | `[<decisions-scaffold>, exploration.md]` | title (+ subset via `components`) | `.mma/specs/<slug>.md` |
| `B2` plan | `[spec.md]` | title + constraints beyond the spec | `.mma/plans/<slug>.md` |
| `B5` execute | `[plan.md]` | `tasks` = plan headings | code (MMA commits) |
| `B1`/`B3` audit | `[spec.md]` / `[plan.md]` | `subtype` | findings (in-context) |
| `B6` review | `[<changed files>]` | acceptance notes | findings (in-context) |

Rule of thumb: **if a prior stage generated a file, pass that file to the stage that needs it — never re-summarise it into the prompt.** The prompt is for what isn't already on disk.

## Stage handbook — what each stage does, who handles it, and how to call it

Every worker dispatch is `POST /task?cwd=<repo-root>`; poll `GET /task/:taskId` to a terminal `200`. **"Main agent"** means you do it in the main session; **"worker"** means a delegated MMA task on a cheap model. Fixes to gitignored `.mma/` artifacts and to source are **always applied inline by the main agent** — never by a fix worker (see "Applying fixes — inline, never dispatched"). The per-skill `SKILL.md` files carry the full request schema; the calls below list the load-bearing fields.

| Stage | What it does | Who handles it | How to call / what to pass |
|---|---|---|---|
| `D1` | Explore — ground the idea | Main agent orchestrates; the 3 legs run on workers | Run `mma-explore`: take the braindump from the user, then fan out `POST /task` × `{type:'investigate', prompt, target:{paths}}`, `{type:'research', prompt}`, `{type:'journal_recall', prompt}` in one message. Main agent synthesises and **writes** `.mma/explorations/<date>-<slug>.md`. |
| `D2` | Brainstorm — grill into decisions | Main agent interviews; mechanical lookups on workers | Run `mma-brainstorm`: read the latest exploration, then grill the user **one decision at a time**. Mechanical questions → `POST /task` (`investigate`/`research`/`journal_recall`); decision questions → the user. Output is a confirmed decision summary held in context (no file). |
| `D3` | Spec — write the formal doc | Worker writes; main agent assembles the payload | `POST /task {type:'spec', prompt:'<title>', target:{paths:['<decisions-scaffold>', '<exploration.md>']}}` — **first path = authoritative confirmed decisions** (scaffolded to a tmp file under the scratchpad), **second = exploration.md grounding**; add `components?:[...]` for a subset. Worker writes `.mma/specs/<date>-<slug>.md`. |
| `B1` | Spec audit loop | Worker audits; **main agent fixes inline** | `POST /task {type:'audit', subtype:'spec', target:{paths:['<specPath>']}}`. Read `output.summary.findings[].weight`; fix blocking `critical`/`high` with `Edit`; re-audit. Escalating gate, hard cap 5, never halts (see "Audit And Review Loop Policy"). |
| `B2` | Plan — write the TDD plan | Worker writes | `POST /task {type:'plan', prompt:'<title>', target:{paths:['<specPath>']}}`. Worker writes `.mma/plans/<date>-<slug>.md`. |
| `B3` | Plan audit loop | Worker audits; **main agent fixes inline** | `POST /task {type:'audit', subtype:'plan', target:{paths:['<planPath>']}}`. Same loop as `B1`. |
| `B4` | Branch | Main agent (git) | `sourceBranch=$(git rev-parse --abbrev-ref HEAD); git checkout -b mma/<slug>`. |
| `B5` | Execute the plan | Worker implements (worktree); main agent verifies | `POST /task {type:'execute_plan', target:{paths:['<planPath>']}, tasks:['<heading>', …]}`. `tasks` are plan headings verbatim (empty ⇒ all). **The plan must contain no git-commit steps — MMA owns the commit.** Main agent verifies against the real `git diff` and fixes worker mistakes inline. |
| `B6` | Review loop | Worker reviews; **main agent fixes inline** | `POST /task {type:'review', target:{paths:['<changed file>', …]}}`. Same escalating-gate loop as `B1`. |
| `B7` | Whole-repo verification | Main agent | Detect and run the repo's build then test (see "B7 — Whole-repo verification command discovery"). |
| `B8` | Push + open PR | Main agent (git + `gh`) | Verify prerequisites, `git push -u origin mma/<slug>`, `gh pr create --base <sourceBranch> --head mma/<slug>`. |
| `B9` | Merge (unconditional) | Main agent (`gh`) | `gh pr merge <n> --merge` — always. The backlog never gates the merge and the flow never pauses for the user; carry the backlog forward to the `B10` terminal report. |
| `B10` | Journal capture | Worker records; main agent composes | `POST /task {type:'journal_record', prompt:'<one concrete learning>'}` per insight (see "B10 — Journal record"). |

### Deferred-Decision Backlog — lazy creation (not at `B1`)

The backlog is **not** created up front. It is created **lazily, on the first append**: the first time any Build stage (`B1`–`B7`) defers a decision, tolerates a missing credential instead of halting (per the anti-interrupt rule), **or leaves a residual critical/high audit-or-review finding after the round cap**, the main agent creates `.mma/backlog/YYYY-MM-DD-<slug>.json` as `{ "entries": [ <that entry> ] }`, commits it to the project branch, and appends every subsequent item to the same file. If a run never defers anything and every audit/review round comes back clean, **no backlog file is ever written** — that is the normal, clean outcome, not an omission. The backlog holds deferred-decision entries and residual-finding entries; run metadata (`sourceBranch`, `slug`, `specPath`, `planPath`) is re-derived by LOCATE and is deliberately not persisted here.

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

`B1`, `B3`, and `B6` share one policy: an **escalating gate with a hard cap of 5 rounds** that **never halts the flow**. Each round is judged on **its own findings** — applying fixes never satisfies the gate by itself; only a subsequent round that itself comes back within threshold does. The threshold loosens as rounds climb:

| Round | Advances when its own findings have… |
|---|---|
| 1–3 | **0 critical AND 0 high** |
| 4–5 | **0 critical** (high findings are tolerated) |

Round 6 never runs — 5 is an absolute ceiling.

1. Run the relevant MMA worker to produce the audit/review findings.
2. Count the critical and high findings **in that round**.
3. Apply the round's threshold:
   - Rounds 1–3: if 0 critical **and** 0 high, the round is clean — stop the loop and advance with nothing left over.
   - Rounds 4–5: if 0 critical, the round passes — append any **residual high** findings to the Deferred-Decision Backlog, then stop the loop and advance.
4. Otherwise, **the main agent applies every blocking fix itself, inline, with `Edit`** (never a dispatched fix worker — see below) — critical + high in rounds 1–3, critical only in rounds 4–5 — then **runs the next round**. Never advance on the strength of the fixes alone: only a round judged within its own threshold clears the gate.
5. The loop is capped at 5 rounds — never a 6th.
6. **The gate never returns `proceed: false` and never stops the flow.** If round 5 still has critical (or high) findings, append every residual finding to the Deferred-Decision Backlog and **advance anyway**. Grilling a single spot past the cap does not improve quality — the residue is left for the backlog and resolves naturally as the rest of the flow proceeds. No human is asked mid-flow.

Residual findings are recorded as backlog entries: `item` = the finding, `assumptionMade` = "advanced past this unresolved <severity> finding after the round cap", `blastRadius` = the finding's stated impact, `blockedWork` = "none — flow continued". A human reviews the backlog only at the very end (see `B10`), never during the flow.

**Worked example.** Round 1 returns 0 critical, 2 high → not clean (rounds 1–3 need 0 high). The main agent edits the spec/plan/source in place to fix both highs, then runs round 2. Round 2 returns 0 critical, 1 high → still not clean. Fix, run round 3. Round 3 returns 0 critical, 1 high → not clean, and the strict window is over. Round 4 runs under the relaxed gate: 0 critical, 1 high → **passes** (highs tolerated); append the residual high to the backlog and advance. Had round 4 still carried a critical, you'd fix it and run round 5. If round 5 still had a critical, append it to the backlog and **advance anyway** — never a round 6, never a halt. This applies identically to spec audit (B1), plan audit (B3), and code review (B6).

### Applying fixes — inline, never dispatched

The audit/review *pass* runs on a worker (`mma-audit`, `mma-review`). The *fix* does not. The main agent applies every fix directly with `Edit` on the real file. **Do not dispatch fixes to `mma-delegate` or `mma-execute-plan`.**

This is not a style preference — it is a correctness requirement:

- `mma-delegate` and `mma-execute-plan` are **worktree routes** (`worktree: true`). The worker edits a *copy* inside an isolated git worktree; the engine merges that worktree back via **git**.
- Spec and plan artifacts live under `.mma/`, which is **gitignored**. Git has nothing to commit or merge for an ignored path, so on worktree cleanup the worker's edits are silently discarded — **and the worker still reports success**, because from its own vantage it did write the file. The fixes vanish. Re-auditing then re-finds the same issues and the loop never converges.

Therefore:

- **B1 (spec audit) and B3 (plan audit)** target gitignored `.mma/` artifacts — the main agent **must** apply fixes inline with `Edit`. A worktree route can *never* persist here.
- **B6 (code review)** targets tracked source on the project branch — inline `Edit` also applies cleanly there. Keep it inline for consistency; do not dispatch.

If a fix is genuinely too large for the main agent to apply inline and a worker is unavoidable, route it through a **`worktree: false`** type (`orchestrate`), which edits the real file in place — never through `delegate`/`execute_plan`.

## Deferred-Decision Backlog

Track everything left unresolved across `B1` through `B9` — deferred human decisions and residual critical/high findings — with entries shaped as:

```ts
export interface DeferredDecisionBacklogEntry {
  item: string;
  assumptionMade: string;
  blastRadius: string;
  blockedWork: string;
}
```

The backlog file (`.mma/backlog/YYYY-MM-DD-<slug>.json`) is created **lazily on the first append** and never exists when nothing was left unresolved — see "Deferred-Decision Backlog — lazy creation".

At `B9`: **merge automatically and unconditionally.** The backlog never gates the merge — there is no second human gate, and the flow does not pause for a human decision at any point. Whatever is in the backlog is carried forward untouched and surfaced to the user exactly once, at the very end of the flow (see `B10`).

## B10 — Journal record (knowledge capture)

After merge, synthesize learnings from the entire flow (D1 through B9) and record them via `mma-journal-record`. This is the knowledge-capture gate — it turns ephemeral session context into durable team knowledge.

### What to capture and what to skip

The journal already holds the team's **known knowns** — things clearly documented, previously decided, or trivially derivable from the codebase. B10 does NOT re-record those. Instead it targets two categories of knowledge that only surface *during* a flow cycle:

**Known unknowns → now resolved.** Gaps we knew existed but filled during this flow. These surface when the flow crosses a system boundary or brings in external information:

- External research (D1/mma-explore) revealed an industry practice, ecosystem constraint, or prior-art pattern we hadn't incorporated
- User input during the requirement interview (D2/mma-brainstorm) clarified an integration point, external system behavior, or business rule that was previously assumed or unknown
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
| D1 (explore) | mma-explore leg results, the written `exploration.md` | Research/investigation/recall findings not previously known; directions explored and dropped (with why) |
| D2 (brainstorm) | mma-brainstorm interview transcript; the confirmed-decision summary | User decisions that resolved ambiguity; contradictions surfaced and reconciled |
| D3 (spec) | The spec file itself; diff between early drafts and final | Requirements that changed shape during iteration; constraints discovered late |
| B1 (spec audit) | Audit findings and fixes | Ambiguities that weren't obvious until audited; assumptions that were wrong |
| B2 (plan) | The plan file; any plan-vs-codebase reconciliation notes | Codebase state that surprised the planner; symbols/paths that didn't exist as assumed |
| B3 (plan audit) | Audit findings and fixes | Cross-task dependencies or sequencing issues discovered; verification commands that needed adjustment |
| B5 (execute) | Worker reports; inline fixes; deferred backlog entries | Implementation surprises — things that worked differently than the plan assumed; workarounds applied |
| B6 (review) | Review findings | Code patterns flagged as inconsistent with existing conventions; edge cases the plan missed |
| B7 (verification) | Test/build failures fixed | Pre-existing issues surfaced; integration points that broke unexpectedly |
| B9 (backlog) | Deferred decisions and residual findings carried to the terminal report | Each backlog entry is a known-unknown left open — record the assumption made and why it was safe to proceed past it |

### Recording

Compose a single `mma-journal-record` prompt per learning. Each entry must be concrete — not "we learned about auth" but "Discovered that the OAuth provider returns `expires_at` as Unix seconds, not milliseconds; our token-refresh logic assumed ms. Reconciled in task I-4." Map each to one of the 6 journal types:

| Journal type | Maps to |
|---|---|
| `decision` | A direction chosen and alternatives dropped — especially directions explored in D1 and rejected with evidence |
| `design` | Architecture or pattern rationale that emerged during the flow — why the structure ended up this way, not just what it is |
| `behavior` | User preferences, communication style, or workflow habits observed during the design interview or backlog resolution |
| `process` | What worked or failed in the SDLC flow itself — which gates caught real issues, which steps were wasteful, what sequencing matters |
| `knowledge` | External facts, API behaviors, ecosystem constraints, or research findings discovered during investigate/research/explore |
| `style` | Naming, documentation, code pattern, or convention norms that were implicit and are now explicit |

### Rules

- **Skip known knowns.** If the learning is already in the journal (run `mma-journal-recall` with a quick probe if unsure), do not re-record it. If it *refines* an existing node, the worker will issue a `refine` operation.
- **Focus on #2 and #3.** Every entry should answer: "What did we not know (or not articulate) before this flow started, that we now know?" If the answer is "nothing new here," skip it.
- **One entry per insight, not per stage.** A single flow might produce 2–8 journal entries, or zero for a trivial change. Don't pad.
- **Concrete over abstract.** Include the specific file, API, behavior, or decision — not a vague category label.
- **B10 never blocks.** If `mma-journal-record` fails, log the failure and report it, but do not roll back the merge or halt the flow. The code is already landed; knowledge capture is best-effort.

### Terminal report — surface the backlog (the only human touchpoint)

`B10` is the last stage. After journal recording completes, the flow is done. Produce a single closing report to the user:

1. State plainly that the flow finished end-to-end — spec, plan, execution, review, verification, PR, merge, and journal are all complete.
2. If `.mma/backlog/YYYY-MM-DD-<slug>.json` exists and its `entries` array is non-empty, show the backlog: list each entry (`item`, `assumptionMade`, `blastRadius`, `blockedWork`) and tell the user these are the deferred decisions and unresolved findings they may want to act on now. This is the **only** point in the entire flow where the human is asked to do anything — and it comes after everything has already landed, not as a gate.
3. If the backlog is absent or empty, say so — the run resolved everything cleanly.

The report never blocks and never rolls anything back. The merge has already happened; this is advisory follow-up.

## Failure Handling

- If Design has not produced a spec yet, stop in the earliest incomplete Design stage (`D1` if no exploration, `D2` if an exploration exists but no confirmed decisions, `D3` if decisions are confirmed but no spec is written).
- If Build starts outside a git repository, stop before `B1`.
- If `mma/<slug>` already exists and matches the active flow, switch to it and rerun LOCATE.
- If the branch name collides with a different in-progress flow, stop and ask the user to resolve the collision.
- If `gh` is unavailable or unauthenticated at `B8`, stop after `B7` and keep the branch intact for manual recovery.
- If `gh pr merge` fails at `B9`, leave the PR open and keep the branch.

## Client Portability

Every supported client installs this playbook. All clients follow the same stage order from this `SKILL.md`.

## Data Model

The flow uses four artifact families:

1. **Exploration artifacts**

```text
.mma/explorations/YYYY-MM-DD-<slug>.md
```

Written at `D1` by `mma-explore` (Background · Current State · Rough Direction). Read at `D2` by `mma-brainstorm` as grounding. Never required once a spec exists.

2. **Spec artifacts**

```text
.mma/specs/YYYY-MM-DD-<slug>.md
```

3. **Plan artifacts**

```text
.mma/plans/YYYY-MM-DD-<slug>.md
```

4. **Deferred-Decision Backlog artifacts**

```text
.mma/backlog/YYYY-MM-DD-<slug>.json
```

Created **lazily on the first append** (not at `B1`; absent when nothing is left unresolved) as `{ "entries": [...] }`. Holds deferred decisions and residual critical/high findings. Committed to the project branch and appended to by subsequent stages. Read once at the **end of the flow** for the terminal report (see `B10`); it never gates the merge, and the flow never pauses for it.

No new server-side schema, task type, or HTTP route is introduced.
