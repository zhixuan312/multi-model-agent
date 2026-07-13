---
name: mma-flow
description: "Claude Code command: /mma-flow — MMA-native design-to-merged-code SDLC playbook that resumes from durable artifacts"
when_to_use: "User explicitly invokes /mma-flow. This is a Claude Code command, not an auto-matched skill."
version: "0.0.0-unreleased"
---

# /mma-flow

A Claude Code command (the user types `/mma-flow`) that orchestrates the MMA SDLC
from idea to merged PR. Not a server endpoint, not an auto-matched skill, not
available on other clients — invoked explicitly. Its **only** input is the initial
**brain dump** (the user's raw idea), taken directly at invocation and fed to D1; on
resume it takes nothing — Stage 0 LOCATE picks up from the durable artifacts on disk.

## The orchestration contract

mma-flow is a **thin orchestrator**. It runs the stages in order; at each stage it
does only three things:

1. **Trigger** — fire one skill (or a git / main-agent action).
2. **Read first** — open that skill's `SKILL.md`; it is the source of *how*. mma-flow
   never re-explains a skill's internals.
3. **Wire** — fill the skill's inputs, stating which ride a `prompt` and which ride
   a file (`target.paths`).

Everything else — how explore fans out, what a journal entry should capture, how an
audit weighs findings — lives in that skill, not here. mma-flow carries only the
stage order, the wiring, and the flow-level policy (the **Common** blocks).

Every worker dispatch is `POST /task?cwd=<repo-root>`; poll `GET /task/:taskId` to a
terminal `200`. "Main agent" = you, in-session; "worker" = a delegated MMA task.

## Stages

Wire shorthand: `exploration.md` / `spec` / `plan` mean the current dated artifact
under `.mma/…/` (LOCATE resolves the exact file); `<scratchpad>` is your session temp
dir, outside any repo, for throwaway dispatch scaffolds.

### D1 — Explore
- Trigger : mma-explore  (main agent)
- Read    : mma-explore/SKILL.md
- Wire    : braindump (direct from the user, at invocation) → prompt
- Out     : `.mma/explorations/YYYY-MM-DD-<slug>.md`

### D2 — Brainstorm
- Trigger : mma-brainstorm  (main agent interviews; mechanical lookups → workers)
- Read    : mma-brainstorm/SKILL.md
- Wire    : exploration.md → read by main agent ; decisions → asked of the user
- Out     : confirmed decisions (in context, no file)

### D3 — Spec
- Trigger : mma-spec  (worker)
- Read    : mma-spec/SKILL.md
- Wire    : target.paths = [`<scratchpad>/decisions.md`, `exploration.md`]  (1st authoritative, 2nd grounding; decisions.md is a throwaway tmp scaffold)
            title → prompt ; optional subset → components[]
- Out     : `.mma/specs/YYYY-MM-DD-<slug>.md`

### B1 — Spec audit
- Trigger : mma-audit subtype:spec  (worker)
- Read    : mma-audit/SKILL.md
- Wire    : spec → target.paths[0] ; subtype → "spec"
- Out     : findings (in context)
- Uses    : Common: Gate · Fixes inline

### B2 — Plan
- Trigger : mma-plan  (worker)
- Read    : mma-plan/SKILL.md
- Wire    : spec → target.paths[0] ; title + target repos + constraints → prompt
- Out     : `.mma/plans/YYYY-MM-DD-<slug>.md`
- Uses    : Common: Multi-repo  (plan tags each task with its repo)

### B3 — Plan audit
- Trigger : mma-audit subtype:plan  (worker)
- Read    : mma-audit/SKILL.md
- Wire    : plan → target.paths[0] ; subtype → "plan"
- Out     : findings (in context)
- Uses    : Common: Gate · Fixes inline

### B4 — Branch
- Trigger : main agent (git), per repo
- Read    : —
- Wire    : —
- Out     : `mma/<slug>` branch in each target repo
- Uses    : Common: Branch & PR · Multi-repo

### B5 — Execute
- Trigger : mma-execute-plan  (worker), once per repo
- Read    : mma-execute-plan/SKILL.md
- Wire    : plan → target.paths[0] ; headings → tasks[] (empty = whole plan)
- Out     : code (MMA commits)
- Uses    : Common: Multi-repo · Never-halt

### B6 — Review
- Trigger : mma-review  (worker), per repo
- Read    : mma-review/SKILL.md
- Wire    : changed files → target.paths[]
- Out     : findings (in context)
- Uses    : Common: Gate · Fixes inline · Multi-repo

### B7 — Verify
- Trigger : main agent, per repo
- Read    : —
- Wire    : build + test commands (auto-detected; user override wins)
- Out     : green — else unfixable failure → backlog
- Uses    : Common: Never-halt · Multi-repo

### B8 — PR
- Trigger : main agent (git + gh), per repo
- Read    : —
- Wire    : push `mma/<slug>` ; `gh pr create --base <that repo's source branch>`
- Out     : one PR per repo
- Uses    : Common: Branch & PR · Multi-repo

### B9 — Merge
- Trigger : main agent (gh), every PR
- Read    : —
- Wire    : `gh pr merge --merge`
- Out     : merged PRs
- Uses    : Common: Never-halt  (backlog never gates)

### B10 — Journal + close
- Trigger : mma-journal-record  (worker), per insight
- Read    : mma-journal-record/SKILL.md   ← the what/how to capture lives THERE
- Wire    : one learning → prompt
- Out     : journal nodes ; then terminal report + surface backlog
- Uses    : Common: Never-halt

## Stage 0 — LOCATE

Run on every invocation. Read durable evidence from disk and resume at the earliest
stage not yet complete for **all** target repos. Session-local evidence (a clean
review, whole-repo green) isn't durable — if only that is missing after an
interruption, fall back to the nearest durable gate (B6 or B7). This is deliberate:
LOCATE resolves the durable BOUNDARIES (spec, plan, branch, commits, PR, merge) from
disk/git; audit/review/verify/journal are session-local, so a fresh-session resume
re-runs them (safe and idempotent) rather than trusting stale session state. A repo
skipped at B8 (no writable remote) is recorded in the backlog so LOCATE won't
re-select it forever.

| Resume signal (durable git/disk + session-local)                      | Resume  |
|-----------------------------------------------------------------------|---------|
| No exploration and no spec                                            | D1      |
| Exploration, no spec                                                  | D2 → D3 |
| Spec, no plan                                                         | B1 → B2 |
| Plan, but not every target repo has an `mma/<slug>` branch            | B3 (if plan not audited this session) → B4 |
| Every repo branched; some repo has no commits past its source branch  | B5      |
| Every repo has commits; no clean review this session (all repos)      | B6      |
| Review clean this session; whole-repo green not yet proven (all repos)| B7      |
| Green proven (all repos); some repo has no PR and isn't backlog-skipped | B8    |
| Some repo's PR open, not merged                                       | B9      |
| Every repo merged or backlog-skipped; no journal this session         | B10     |
| Every repo merged or backlog-skipped; journal recorded this session   | done    |

Multi-artifact: if the user's current message points at a specific artifact, use it;
otherwise (the default — including a headless resume) use the most-recent spec under
`.mma/specs/` and the plan whose slug matches. Artifact roots resolve in the primary
repo.

## Common: Gate   (B1, B3, B6)

Escalating gate, hard cap 5 rounds, never halts. Each round is judged on its OWN
findings — applying fixes never clears the gate; only a fresh round that comes back
within threshold does.

| Round | Advance when the round's own findings have… |
|-------|---------------------------------------------|
| 1–3   | 0 critical AND 0 high                       |
| 4–5   | 0 critical   (high tolerated → backlog)     |

- Round doesn't clear the gate → fix inline (Common: Fixes inline), then run the next round.
- Round 6 never runs. Residual after round 5 (critical or high) → backlog, advance anyway.
- Never returns `proceed: false` — the flow never stops here.

## Common: Never-halt

The flow never halts on **content** — audit/review/verification findings, missing
credentials, deferred decisions all drain to the backlog and the flow advances. It
may stop only on unresolved **setup** ambiguity it cannot decide autonomously
(missing repo path, branch-name collision) — never on a finding or a decision.

Backlog: one file — `.mma/backlogs/YYYY-MM-DD-<slug>.json` in the primary repo.
- Created lazily on the first append; if nothing is ever deferred, it never exists.
- Uncommitted working-tree file (`.mma/` is gitignored — see Common: Fixes inline).
- Entry: `{ item, assumptionMade, blastRadius, blockedWork }`.
- Holds deferred decisions + residual critical/high findings, across all repos.
- Never gates the merge (B9). Read once at B10 and surfaced to the user — the only
  human touchpoint, after everything has landed.

## Common: Fixes inline   (B1, B3, B6)

The audit/review PASS runs on a worker; the FIX does not. The main agent applies
every fix directly with `Edit` on the real file — never via mma-delegate or
mma-execute-plan.

Why: those are worktree routes — the worker edits a copy that git merges back.
Spec/plan artifacts live under `.mma/`, which is gitignored, so the merge silently
discards the edits (and the worker still reports success) → the loop never
converges. B6 targets tracked source, where inline `Edit` also applies cleanly —
keep it inline for consistency.

If a fix is genuinely too large for inline, route it through a `worktree:false`
type (orchestrate), which edits in place — never delegate/execute_plan.

## Common: Branch & PR   (B4, B8, B9)

Slug ← spec title: lowercase; non-alphanumeric runs → "-"; collapse repeats; trim
leading/trailing "-"; truncate to 30; fallback "task".

Per repo (see Common: Multi-repo):

```bash
srcBranch=$(git -C <repo> rev-parse --abbrev-ref HEAD)     # B4
git  -C <repo> checkout -b mma/<slug>
git  -C <repo> push -u origin mma/<slug>                   # B8
gh   pr create --base <srcBranch> --head mma/<slug>        # B8, run from <repo>
gh   pr merge  <n> --merge                                 # B9
```

PR title: `build(<slug>): <one-line spec summary>`.
Open a repo's PR only after B7 passes for that repo this session.

`srcBranch` is captured at B4 for in-session use. On a fresh-session resume it's gone,
so default `--base` to the repo's default branch (`origin/HEAD`). Branching from a
non-default source isn't guaranteed to survive resume — note it in the brain dump if
it matters.

B8 prerequisites (per repo): writable `origin` on GitHub · `gh` authenticated ·
source branch still on the remote. Any missing → backlog entry, skip that repo's
PR, continue with the rest (Common: Never-halt).

## Common: Multi-repo   (B4–B9)

Only B4–B9 fan out. Design + audit (D1–B3) and B10 run ONCE — one exploration,
spec, plan, journal pass, and backlog cover the whole flow. N = 1 (single repo) is
the ordinary case; every rule below collapses to it.

- Repo set comes from the plan (B2 tags each task with its repo). The invocation
  cwd is the PRIMARY repo — it owns `.mma/` (exploration, spec, plan, backlog).
  Every other repo is SECONDARY: branch + code + PR only.
- Before B4, resolve each repo name → absolute root. Can't find one → ask the user
  once (setup, not a mid-flow decision).
- Barrier per stage: finish a stage across ALL repos before advancing. LOCATE
  resumes at the earliest stage not yet complete for all repos.
- B5 needs the plan inside each worker's cwd (`copyToWorktree` takes a path relative
  to cwd; the primary's plan escapes a secondary worktree). So for each SECONDARY
  repo, copy the plan into it and pass the in-cwd path; delete after. The primary /
  single repo needs no copy.

## Data model

All artifacts live under the PRIMARY repo's `.mma/` (the invocation cwd); secondary
repos hold only branches, code, and PRs.

```text
.mma/explorations/YYYY-MM-DD-<slug>.md   D1 — grounding; not needed once a spec exists
.mma/specs/YYYY-MM-DD-<slug>.md          D3
.mma/plans/YYYY-MM-DD-<slug>.md          B2
.mma/backlogs/YYYY-MM-DD-<slug>.json      lazy; uncommitted (see Common: Never-halt)
```

No server schema, task type, or HTTP route is added — `/mma-flow` is client-side.

## Failure handling

Never halts on content (see Common: Never-halt). Stops only on setup ambiguity:

- Design produced no spec yet → stop at the earliest incomplete Design stage.
- Build started outside a git repo → stop before B1.
- A target repo's path can't be resolved → ask the user once, then continue.
- `mma/<slug>` already exists and matches this flow → switch to it, rerun LOCATE.
- Branch-name collision with a different flow → stop, ask the user to resolve.
- `gh` missing/unauth for a repo at B8 → skip that repo's PR (backlog), continue.
- `gh pr merge` fails for a repo at B9 → leave that PR open, merge the rest, note it.
