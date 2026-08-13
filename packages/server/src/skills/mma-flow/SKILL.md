---
name: mma-flow
description: "Claude Code command: /mma-flow — MMA-native solution delivery playbook (pr, commit-in-place, or deliver-file) that resumes from durable artifacts"
when_to_use: "User explicitly invokes /mma-flow. This is a Claude Code command, not an auto-matched skill."
version: "0.0.0-unreleased"
disable-model-invocation: true
---

# /mma-flow

A Claude Code command (the user types `/mma-flow`) that orchestrates the MMA solution
development lifecycle from idea to a verified, delivered solution. Not a server endpoint, not an
auto-matched skill, not available on other clients — invoked explicitly. Its **only** input is
the initial **brain dump** (the user's raw idea), taken directly at invocation and fed to D1. A
**bare** invocation (no braindump — headless cron, or the user just typed the command) takes
nothing: Stage 0 LOCATE picks up from the durable artifacts on disk. A braindump naming work
already on disk resumes that flow; a braindump naming NEW work starts a fresh flow even when
unrelated artifacts exist (see Stage 0 — LOCATE).

The flow delivers ONE approved Deliverable Contract through ONE `disposition` — `pr`,
`commit-in-place`, or `deliver-file` — declared on the contract and never inferred from
git-ness. A solution needing two different delivery modes runs as two flows (one contract, one
disposition, one flow). Before any disposition-specific stage runs, LOCATE checks the contract's
approval state first, on every invocation (Common: Approval).

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
stage order, the wiring, and the flow-level policy (the **Common** blocks, including the
disposition-driven LOCATE matrix and the approval gate).

Every worker dispatch calls the `mma_run` MCP tool with `cwd=<repo-root>`; poll with
`mma_execution_get` / `mma_execution_wait` to a terminal result. If `mma_run` is not available in
this session, run `mma clients`. "Main agent" = you, in-session; "worker" = a delegated MMA
execution.

## Stages

Wire shorthand: `exploration.md` / `spec` / `plan` mean the current dated artifact
under `.mma/…/` (LOCATE resolves the exact file); `<scratchpad>` is your session temp
dir, outside any repo, for throwaway dispatch scaffolds.

### D1 — Explore
- Trigger : mma-explore  (main agent)
- Read    : mma-explore/SKILL.md
- Wire    : braindump (direct from the user, at invocation) → prompt
- Out     : `.mma/explorations/<stem>.md`  (mints the stem — see Common: Artifact stem)
- Uses    : Common: Artifact stem

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
- Out     : `.mma/specs/<stem>.md`  (inherited from the dated exploration source — no outputPath threaded), carrying a `proposed` Deliverable Contract (`kind`, `audience`, `artifacts`, `acceptance`, `disposition`)
- Uses    : Common: Artifact stem

### B1 — Spec audit
- Trigger : mma-audit subtype:spec  (worker)
- Read    : mma-audit/SKILL.md
- Wire    : spec → target.paths[0] ; subtype → "spec"
- Out     : findings (in context)
- Uses    : Common: Gate · Fixes inline

### B2 — Plan
- Trigger : mma-plan  (worker) — one dispatch PER involved repo (fan-out; N=1 single repo)
- Read    : mma-plan/SKILL.md
- Wire    : spec → target.paths[0] ; per dispatch: the one repo's scope + constraints → prompt
- Out     : one plan per repo — `.mma/plans/<stem>--<repo-slug>.md` under the parent (single repo: `<stem>.md`)
- Uses    : Common: Artifact stem · Common: Multi-repo  (one spec → one plan per repo)

### B3 — Plan audit
- Trigger : mma-audit subtype:plan  (worker)
- Read    : mma-audit/SKILL.md
- Wire    : plan → target.paths[0] ; subtype → "plan"
- Out     : findings (in context)
- Uses    : Common: Gate · Fixes inline

### Contract approval — checked on every LOCATE pass, not a one-time stage
- Trigger : the responsible human (or Forge), never the engine
- Read    : Common: Approval
- Wire    : —
- Out     : `contractApproval` (`contractDigest`, `approvedBy`, `approvedAt`) recorded on the contract
- Uses    : Common: Approval

No B-stage after B3 runs while the contract's `state` is `proposed`, or while its content digest
no longer matches its recorded `contractApproval.contractDigest` — see Stage 0 — LOCATE.

### B4 — Branch + clean start  (`pr` only)
- Trigger : main agent (git), per repo
- Read    : —
- Wire    : —
- Out     : `mma/<slug>` branch in each target repo, with a CLEAN working tree
- Uses    : Common: Branch & PR · Common: Clean start · Multi-repo

Never selected for `commit-in-place` or `deliver-file` — those two dispositions have no B4 row
in Stage 0 — LOCATE.

### B5 — Execute
- Trigger : mma-execute-plan  (worker), once per repo
- Read    : mma-execute-plan/SKILL.md
- Wire    : plan → target.paths[0] ; headings → tasks[] (empty = whole plan)
- Out     : the deliverable — committed on the branch cut at B4 (`pr`), committed directly on the
            current branch (`commit-in-place`), or written to the declared artifact path
            (`deliver-file`)
- Uses    : Common: Multi-repo · Never-halt

For `commit-in-place`, capture that repo's `commitBaseline` (Common: Clean start) BEFORE this
stage runs, never after.

### B6 — Review
- Trigger : mma-review  (worker), per repo
- Read    : mma-review/SKILL.md
- Wire    : changed files → target.paths[]
- Out     : findings (in context); for every acceptance criterion whose method is `agent-review`,
            a `passed` / `failed` verdict the caller persists as a `VerificationRecord` at
            `record.outcome.status` (Common: Acceptance closure)
- Uses    : Common: Gate · Fixes inline · Multi-repo

### B7 — Verify
- Trigger : main agent, per repo
- Read    : Common: Verify
- Wire    : the contract's declared `command` acceptance criteria, run in declared order —
            never auto-detected build or test commands
- Out     : each criterion's outcome (`passed` / `failed` / `error`) recorded at
            `record.outcome.status`; green → advance, an unfixable failure → backlog (never
            silently substituted with an `agent-review` or `human` outcome)
- Uses    : Common: Never-halt · Multi-repo · Common: Acceptance closure

### B8 — PR  (`pr` only)
- Trigger : main agent (git + gh), per repo
- Read    : —
- Wire    : push `mma/<slug>` ; `gh pr create --base <that repo's source branch>`
- Out     : one PR per repo
- Uses    : Common: Branch & PR · Multi-repo · Common: Bounded non-progress

### B9 — Merge  (`pr` only)
- Trigger : main agent (gh), every PR
- Read    : —
- Wire    : `gh pr merge --merge`
- Out     : merged PRs
- Uses    : Common: Never-halt  (backlog never gates B9 itself; see Common: Acceptance closure
  for what gates `done`)

### B10 — Journal + close
- Trigger : mma-journal-record  (worker), per insight
- Read    : mma-journal-record/SKILL.md   ← the what/how to capture lives THERE
- Wire    : one learning → prompt
- Out     : journal nodes; then a terminal report of `done` (only once acceptance-closed — Common:
            Acceptance closure) plus the surfaced backlog
- Uses    : Common: Never-halt

## Stage 0 — LOCATE

Run on every invocation. Read durable evidence from disk and git and resume at the earliest
stage not yet complete. Session-local evidence (a clean review this session, a green command run
this session) isn't durable — if only that is missing after an interruption, fall back to the
nearest durable gate (B6 or B7). This is deliberate: LOCATE resolves durable BOUNDARIES (contract
state, branch, commits, artifacts, PR, merge, recorded acceptance evidence) from disk/git;
review/verify/journal session flags are session-local, so a fresh-session resume re-runs them
(safe and idempotent) rather than trusting stale session state.

**Braindump vs. resume — decide this first.** Before consulting the table, settle
which flow LOCATE is even acting on. `/mma-flow` is invoked either with a braindump
argument or bare, and that argument decides new-vs-resume:

- **Bare** (no argument) → pure resume: select the most-recent flow on disk (per
  Multi-artifact below) and resume it at the earliest incomplete stage.
- **Braindump present** → derive its topic, then scan `.mma/explorations/` +
  `.mma/specs/` for an artifact covering THAT work:
  - Matches an existing flow → resume THAT flow's artifacts. Re-pasting the same idea
    is idempotent: it continues the flow, never forks a duplicate.
  - Matches nothing on disk → this is a NEW flow. Start at **D1** with a fresh dated
    slug, even when unrelated explorations / specs / plans exist. Never resume a
    stale, unrelated artifact just because it is the most recent.
  - Genuinely ambiguous (could plausibly be either) → setup ambiguity: ask the user
    once whether to continue `<existing slug>` or start fresh, then proceed. This is
    the one permitted setup-only stop (Common: Never-halt) — never guess.

The table below then applies to the SELECTED flow's artifacts (a NEW flow has neither
exploration nor spec, so it lands on the D1 row).

**Evaluation order.** LOCATE checks the four `*any*` rows FIRST, in this fixed order, before ANY
disposition row, regardless of `disposition`:

1. Any `stageSkipped` entry exists → **stopped-unmet-requirements** (Common: Bounded
   non-progress)
2. A plan exists and the contract's `state` is `proposed` → **awaiting-approval** — a STOP; a
   scoped exception to Never-halt (Common: Approval)
3. The contract's `state` is `approved`, but its content digest no longer matches
   `contractApproval.contractDigest` → **awaiting-reapproval** — a STOP (Common: Approval)
4. Any `human` acceptance criterion has a current record whose outcome is `rejected` →
   **stopped-unmet-requirements** (the rejected criterion is named in the backlog)

Only once none of the four match does LOCATE read the disposition rows below, top to bottom,
first match wins. Every disposition row carries an implicit "AND that stage is not
`stageSkipped`" guard — a skipped stage is never re-selected; evaluation falls through it.

In multi-repository mode every git signal — branch, commits past `commitBaseline`, PR, merged —
reads PER REPOSITORY, exactly as this table always has ("every target repo has…", "some repo has
no…"); the rows below are the single-repository reading of the same rule (Common: Multi-repo
applies each row's condition to every involved repository).

**`acceptance-closed`** in the rows below means `acceptanceClosed(contract, evidence,
subjectDigest)` is true (Common: Acceptance closure) — every criterion, `command`, `agent-review`,
and `human` alike, has a CURRENT record bound to the present output.

| Disposition | Partial durable state | Next |
|---|---|---|
| `pr` | no `mma/<slug>` branch | B4 |
| `pr` | branch exists, no commits past source branch | B5 |
| `pr` | commits exist, no clean review this session | B6 |
| `pr` | review clean, declared commands not yet all passing | B7 |
| `pr` | commands pass, no PR | B8 |
| `pr` | PR open, not merged | B9 |
| `pr` | merged, any `human` criterion with no current record or a `not-run` outcome | **awaiting-human-verification** (stop; exempt from Bounded non-progress) |
| `pr` | merged, acceptance-closed, no journal this session | B10 |
| `pr` | merged, acceptance-closed, journal recorded | **done** |
| `commit-in-place` | no commit on the current branch past `commitBaseline` | B5 |
| `commit-in-place` | commit exists, no clean review this session | B6 |
| `commit-in-place` | review clean, declared commands not yet all passing | B7 |
| `commit-in-place` | commands pass, any `human` criterion with no current record or a `not-run` outcome | **awaiting-human-verification** (stop; exempt from Bounded non-progress) |
| `commit-in-place` | commands pass, acceptance-closed, no journal this session | B10 |
| `commit-in-place` | commands pass, acceptance-closed, journal recorded | **done** |
| `deliver-file` | any declared artifact missing at its own declared root, or `artifacts: []` with the terminal `command` criterion not yet passing | B5 |
| `deliver-file` | all artifacts present (or the terminal command passing), no clean review this session | B6 |
| `deliver-file` | review clean, declared commands not yet all passing | B7 |
| `deliver-file` | commands pass, any `human` criterion with no current record or a `not-run` outcome | **awaiting-human-verification** (stop; exempt from Bounded non-progress) |
| `deliver-file` | commands pass, acceptance-closed, no journal this session | B10 |
| `deliver-file` | commands pass, acceptance-closed, journal recorded | **done** |

`pr` is the only disposition whose rows mention a branch, PR, or merge — B4, B8, and B9 are
unreachable for the other two. `commit-in-place` and `deliver-file` never cut a branch and never
open a PR; B5 there commits directly on the branch already checked out, or writes the declared
artifact, in place. The three stopping rows — `awaiting-approval`, `awaiting-reapproval`,
`awaiting-human-verification` — are waits on a human decision, never failures and never
non-progress: resume re-reads the same table once the awaited record exists. `agent-review`
criteria need no waiting row of their own, because B6 produces their records — a missing
`agent-review` record means B6 has not yet produced a clean review, which the review rows
already cover.

Multi-artifact: once the braindump-vs-resume decision has selected a flow, resolve its
exact files by stem under `.mma/…/` (Common: Artifact stem — same stem end to end, so
this is an exact match, not a fuzzy one). If the user's current message points at a
specific artifact, use it. A bare resume with several flows on disk defaults to the
most-recent spec under `.mma/specs/` and the plan sharing its stem. Artifact roots
resolve in the primary repo.

## Common: Approval   (the *any* rows checked 2nd and 3rd)

Governs `awaiting-approval` and `awaiting-reapproval` — the scoped exception to Common:
Never-halt (FR-6a). Both stop progression rather than draining to the backlog, because executing
against a definition of done nobody confirmed is the false-success failure this flow exists to
prevent.

- **`awaiting-approval`.** A plan exists and the contract's `state` is `proposed`. The flow stops
  and asks the responsible human (or Forge) to review the proposed `kind`, `audience`,
  `artifacts`, `acceptance` criteria, and `disposition`, then record a `contractApproval`
  (`contractDigest`, `approvedBy`, `approvedAt`) over the contract's own canonical digest. Resume
  re-reads LOCATE once that record exists — no B-stage after B3 runs while `state` is `proposed`.
- **`awaiting-reapproval`.** The contract's `state` is `approved`, but recomputing its canonical
  digest from its current content no longer matches `contractApproval.contractDigest` — the
  content changed after approval. The flow stops the same way; a fresh `contractApproval` over
  the new digest is required before any disposition row is read again.
- Both stops write NO terminal marker — they are resumable, and Common: Bounded non-progress
  never counts them.
- `state` and `contractApproval` are caller-owned, exactly like `commitBaseline` and
  `stageSkipped` (Common: Never-halt) — mma-flow reads and writes them; the engine never
  persists any of the three.

## Common: Gate   (B1, B3, B6)

Escalating gate, hard cap 3 rounds, never halts. Each round is judged on its OWN
findings — applying fixes never clears the gate; only a fresh round that comes back
within threshold does.

| Round | Advance when the round's own findings have…     |
|-------|------------------------------------------------|
| 1     | 0 critical AND 0 high                          |
| 2     | 0 critical   (high tolerated → backlog)        |
| 3     | anything — round 3 always advances             |

- Round doesn't clear the gate → fix inline (Common: Fixes inline), then run the next round.
- Round 3 is the last pass: apply its fixes, then advance unconditionally. Round 4 never
  runs. Residual after round 3 (critical or high) → backlog, advance anyway.
- Never returns `proceed: false` — the flow never stops here.

## Common: Never-halt

The flow never halts on **content** — audit/review/verification findings, missing
credentials, deferred decisions all drain to the backlog and the flow advances. It
may stop only on unresolved **setup** ambiguity it cannot decide autonomously
(missing repo path, branch-name collision) — never on a finding or a decision.

Two named exceptions stop the flow deliberately, and both are documented in full elsewhere: the
approval gate's `awaiting-approval` / `awaiting-reapproval` (Common: Approval), and a `human`
criterion's `rejected` outcome (Common: Acceptance closure), which ends the flow at
`stopped-unmet-requirements` — an honest answer to a question already asked, not a content
finding to drain to the backlog.

Backlog: one file — `.mma/backlogs/<stem>.json` in the primary repo (same stem as the
rest of the chain — see Common: Artifact stem).
- Created lazily on the first append; if nothing is ever deferred, it never exists.
- Uncommitted working-tree file (`.mma/` is gitignored — see Common: Fixes inline).
- Entry: `{ item, assumptionMade, blastRadius, blockedWork }`. A rejected `human` criterion's
  entry names the criterion id in `item`.
- Holds deferred decisions + residual critical/high findings, across all repos.
- Never gates the merge (B9). Read once at B10 and surfaced to the user — the only
  human touchpoint, after everything has landed.

## Common: Acceptance closure   (gates `done`)

`done` requires three things: the disposition's delivery signal, `acceptanceClosed` over the
current evidence, and a journal record this session. Delivery alone is not enough — an earlier
design let `done` render even with a `human` criterion still `not-run`.

**Do not re-implement this rule or the subject digest.** Both ship from
`@zhixuan92/multi-model-agent-core`, because closure only works if every component computes the
SAME digest for the same output. A second implementation would fail silently and in the worst
possible way: evidence written by one component reads as STALE to the other, so a finished flow
waits forever for verification it already has, with no error raised anywhere.

```ts
import { canonicalSubjectDigest, acceptanceClosed } from '@zhixuan92/multi-model-agent-core';

// WHAT was checked — git commits per repository, or file digests per (root, path).
const subjectDigest = canonicalSubjectDigest(subject);
const closed = acceptanceClosed(contract.acceptance, evidence.records, subjectDigest);
```

The rule it applies, for reference — four independent reasons a record proves nothing:

```ts
if (!record) return false;                                    // no evidence at all
if (record.subjectDigest !== subjectDigest) return false;      // evidence is for a STALE output
if (record.outcome.method !== criterion.method) return false;  // evidence used the wrong method
switch (criterion.method) {
  case 'command':
  case 'agent-review': return record.outcome.status === 'passed';
  case 'human':        return record.outcome.status === 'approved';
}
```

The status lives at `record.outcome.status`, NEVER on the record itself — evidence is
method-specific. `failed`, `error`, and `not-run` all fail closure for a `command` or
`agent-review` criterion; `rejected` and `not-run` both fail closure for a `human` criterion.

| Method | Producer of the record |
|---|---|
| `command` | B7 execution — the CALLER runs the declared command and persists the outcome. No engine route executes acceptance commands: they verify the caller's own delivery, and the engine is stateless about the flow. |
| `agent-review` | The B6 independent reviewer, per criterion |
| `human` | Forge, or the interactive caller, recording a named person's decision |
| All methods | The caller writes `.mma/verifications/<stem>.json` — never the engine |

**The two non-closing `human` states are DIFFERENT states — never merge them:**

| `human` criterion state | Meaning | LOCATE outcome |
|---|---|---|
| No current record, or `not-run` | Nobody has decided yet | `awaiting-human-verification` — a resumable WAIT, exempt from Bounded non-progress |
| A current record with `rejected` | A responsible person decided NO | `stopped-unmet-requirements` — an ANSWER, not a wait; the rejected criterion is named in the backlog |

A rejected decision is settled, not pending: treating it as a wait would sit the flow on a
question already answered; treating it as `done` would be the false success this flow exists to
prevent.

A `command` outcome is never substituted with an `agent-review` or `human` verdict, and an
`error` outcome blocks closure exactly as `failed` does, while recording a different fact — the
command could not run (missing program, timeout, spawn failure), versus it ran and reported
failure.

## Common: Fixes inline   (B1, B3, B6)

The audit/review PASS runs on a worker; the FIX is applied by the main agent with
`Edit` on the real file.

This used to be a hard prohibition, because delegate/execute_plan ran inside a git
worktree: the worker edited a copy that was merged back, and `.mma/` is gitignored,
so a merge silently discarded every spec/plan edit while the worker still reported
success — the loop could never converge. Write routes now edit the caller's checkout
IN PLACE, so that failure mode is gone and a gitignored path is no longer special.

Inline `Edit` remains the default because it is faster and keeps the audit-fix loop
in one context. A fix genuinely too large for inline may go to a worker; there is no
longer a route that would silently drop it.

**Bump the version each fix round.** The `.mma/` design artifacts (exploration, spec,
plan) carry YAML frontmatter (`version` + `updated_at`). After applying a round's fixes
to a spec (B1) or plan (B3), increment that file's `version` by 1 and set `updated_at`
to today's date — once per round, after the round's edits, not once per finding. So
`version: N` means the artifact survived `N-1` audit-fix rounds. A round that clears the
gate with zero findings makes no edit and no bump.

## Common: Branch & PR   (B4, B8, B9 — `pr` only)

Only reached when `disposition` is `pr` (Stage 0 — LOCATE); `commit-in-place` and
`deliver-file` never run these three stages.

`<slug>` = the slug half of the stem (Common: Artifact stem) — the same string across
artifacts and branch. The branch is never slugged independently; read it off the
exploration/spec filename.

Per repo (see Common: Multi-repo):

```bash
srcBranch=$(git -C <repo> rev-parse --abbrev-ref HEAD)     # B4
git  -C <repo> checkout -b mma/<slug>                      # B4 — branch BEFORE committing WIP
git  -C <repo> add -A && git -C <repo> commit -m "chore: pre-existing work"   # B4 — see Clean start
git  -C <repo> push -u origin mma/<slug>                   # B8
gh   pr create --base <srcBranch> --head mma/<slug>        # B8, run from <repo>
gh   pr merge  <n> --merge                                 # B9
```

PR title: `build(<slug>): <one-line spec summary>`.
Open a repo's PR only after B7 passes for that repo this session.

B8 prerequisites (per repo): writable `origin` on GitHub · `gh` authenticated ·
source branch still on the remote. A missing prerequisite means B8 makes no progress for that
repo; Common: Bounded non-progress governs what happens next — it is no longer a soft per-repo
skip that lets the rest of the flow reach `done`. Every `stageSkipped` entry is an unconditional
`*any*` row, so two consecutive no-progress selections of B8 end the WHOLE flow at
`stopped-unmet-requirements`, not just that repo's PR.

## Common: Clean start   (B4 — `pr`; and the `commit-in-place` baseline)

**Execution must begin from a clean tree.** The engine commits with `git add -A`, so anything
uncommitted when B5 dispatches gets swept into the task's commit — mixing your in-progress work
into MMA's, and making `output.filesChanged` describe both. This holds for BOTH `pr` and
`commit-in-place` — only the branching differs between them.

For `pr`, at B4, per repo, **in this order**:

```bash
git -C <repo> checkout -b mma/<slug>          # 1. cut the branch FIRST
git -C <repo> status --porcelain              # 2. anything left?
git -C <repo> add -A                          # 3. …then commit it, on the NEW branch
git -C <repo> commit -m "chore: pre-existing work before <slug>"
```

The order is the point. Committing BEFORE branching would put your in-progress work on the
source branch (often `master`) — the one place it must not land. Branching first keeps the
source branch untouched and preserves the work as its own commit on the task branch, where it
stays separable in review: one commit that is yours, then MMA's commits on top.

After this, `execution.dirtyAtDispatch` comes back `false` for every B5 dispatch and each
engine commit contains only that task's work. If it comes back `true`, B4 did not run or
something wrote to the tree mid-flow — worth a look, not a halt.

Nothing is ever stashed or discarded. A clean start means *committed*, never *thrown away*.

`srcBranch` is captured at B4 for in-session use. On a fresh-session resume it's gone,
so default `--base` to the repo's default branch (`origin/HEAD`). Branching from a
non-default source isn't guaranteed to survive resume — note it in the brain dump if
it matters.

**`commit-in-place` has no B4.** There is no branch to cut — B5 commits directly on the branch
already checked out. Before B5 runs for a repo under this disposition, capture that repo's
current HEAD as `commitBaseline` and persist it — one baseline PER REPOSITORY in multi-repo mode
(Common: Multi-repo):

```bash
commitBaseline[<repositoryId>]=$(git -C <repo> rev-parse HEAD 2>/dev/null || echo null)
```

A repo with no commit yet at capture time stores the explicit sentinel `null`, never an absent
key — LOCATE's "no commit past `commitBaseline`" row must be able to tell "nothing captured yet"
from "captured, and it was empty". A resumed flow reads the stored value and never re-derives
it. `commitBaseline` lives in `.mma/flow-state/<stem>.json` (Data model) — caller-owned, never
written by the engine.

## Common: Verify   (B7)

B7 runs the approved contract's declared `command` acceptance criteria, and ONLY those — it must
never auto-detect a build or test command. Each check runs `{ program, args, cwd, timeoutMs }`
with no shell interpretation, in declared order, because a later check may legitimately depend
on an earlier one (a build before the check that reads its output).

B7 is re-entered on every resume until every declared command passes, so a criterion's command
MUST be verification-only — it answers "is the claim true?" and changes nothing in the external
world (`kubectl diff`, never `kubectl apply`). A command that uploads, publishes, imports,
deploys, or sends a message must never appear here; re-running it on resume would repeat that
action. Post-delivery actions are caller-owned and out of scope — the caller performs the
action, and a `command` criterion checks the resulting state.

A criterion whose `command` field is genuinely absent while its method is `command` was already
rejected as invalid input before this stage runs. A validly declared command that cannot start,
cannot be resolved on PATH, or exits non-zero is a B7 failure — recorded as failed evidence,
never silently substituted with an `agent-review` or `human` outcome (Common: Acceptance
closure).

**The bounds every declared command runs under.** These are the contract's teeth: a criterion
that can hang forever, or flood the log, or resolve its own working directory, is not a check.
The two limits are exported from `@zhixuan92/multi-model-agent-core` so the caller applies the
same numbers the schema validates against — never a second hand-written copy.

| Bound | Value | Where it comes from |
|---|---|---|
| Default timeout when `timeoutMs` is omitted | `600000` ms | `DEFAULT_COMMAND_TIMEOUT_MS` |
| Highest `timeoutMs` a contract may declare | `1800000` ms | `MAX_COMMAND_TIMEOUT_MS`; a higher value is rejected as invalid input before B7 |
| Combined stdout+stderr captured from one run | 32 MiB | `MAX_CAPTURED_OUTPUT_BYTES` |
| Default `cwd` when omitted | the workspace root | resolved by the caller; a declared `cwd` escaping the workspace root is rejected as invalid input before B7 |

**`failed` and `error` are different outcomes and must not be merged.** `failed` means the check
ran and the claim is false — a real verdict about the deliverable. `error` means the check never
produced a verdict, so nothing was learned; record it with the reason, in `record.outcome`:

| Situation | `status` | `errorKind` |
|---|---|---|
| Command ran, exited non-zero | `failed` | — |
| Exceeded its timeout | `error` | `timeout` |
| Could not start, or not on PATH | `error` | `spawn-failure` |
| Output exceeded 32 MiB and was truncated | `error` | `spawn-failure`, stating the truncation in `detail` |

Both `failed` and `error` block acceptance closure (Common: Acceptance closure). The distinction
is not about whether the flow advances — neither advances it — but about what a person reads
afterwards: "the deliverable is wrong" and "we never found out" call for different next actions.

## Common: Bounded non-progress

If LOCATE selects the same stage twice consecutively for the same repo and that stage's durable
signal has not advanced between the two selections, it must not select that stage a third time.
Instead, in ONE durable write, it records a backlog entry naming the stage and its unmet signal
AND sets `stageSkipped[<stage>] = true`. The marker is durable and disposition-independent —
without it, the next resume would recompute from the unchanged signal and land back on the very
stage LOCATE just forced past. `stageSkipped` lives in `.mma/flow-state/<stem>.json` (Data
model) alongside `commitBaseline` — caller-owned, never written by the engine.

**Exactly two durable writes reach `stopped-unmet-requirements`, and both are unconditional
`*any*` rows** (Stage 0 — LOCATE, checked before every disposition row):

| Terminal write | Cause |
|---|---|
| `stageSkipped[<stage>] = true` | This rule forced past a stage whose signal never advanced |
| A backlog entry naming a rejected criterion | A responsible person recorded `rejected` on a `human` criterion (Common: Acceptance closure) |

A skip means the flow gave up on a signal it could not satisfy. A rejection means a person
answered the question and the answer was no. Both are honest terminations — neither may ever be
reported as `done`. `awaiting-approval`, `awaiting-reapproval`, and `awaiting-human-verification`
are NOT part of this rule: they write no terminal marker and are resumable stops, not
non-progress.

## Common: Multi-repo   (parent-aware; D1–B10)

The product may be one repo or several sibling repos under a **parent workspace**. Which
one you're in is DETECTED, not declared.

**Topology detection (run once, at flow start).** Enumerate the immediate child
directories of the invocation cwd and test each for a `.git` entry (file OR directory).
Detection **does not recurse** into subdirectories and **does not follow symlinks** — it
only inspects **immediate child** directories.
- **≥1 git child → multi-repo mode.** The invocation cwd is the **parent workspace**; the
  git children are the candidate sub-projects. The parent (typically itself non-git) owns
  ALL durable artifacts.
- **0 git children → single-project mode.** Everything is one project rooted at the cwd;
  behave EXACTLY as before — no involved-repo proposal, no fan-out, no artifact relocation.
  Every rule below collapses to N = 1.

`CLAUDE.md` is **optional context enrichment** only (what each sub-project is). Its absence
never blocks detection or the flow; detection is purely structural.

**Involved-repo confirmation (multi-repo mode, before D1 investigation/recall).** Propose
the detected git children as the **involved repo** set and let the user confirm, remove a
repo, or ADD a non-git **immediate child** directory (path-confined: reject any `..`,
absolute path, or non-immediate-child). If the confirmed set is empty or invalid,
**re-prompt** — never proceed. If two child names normalize to the same lowercase-kebab
slug (a **slug collision**), halt and re-prompt for explicit disambiguating slug overrides
before proposing the set — plan filenames and journal topics must stay unique.

**Parent owns everything (multi-repo mode).** The **parent workspace** owns the entire
`.mma/` tree — journal, explorations, specs, plans, backlogs, flow state, verifications —
reached by dispatching the design/journal legs with `cwd = parent workspace`. Forge durable
design docs go to the parent `design/<stem>.md` (only when that step runs), never a child repo.
Sub-repos hold code, branches, and PRs only.

**One spec → one plan per repo (fan-out at B2).** One shared spec captures the goal.
**Fan out one `mma-plan` dispatch per involved repo** — each scoped to exactly one repo,
each writing `.mma/plans/<stem>--<repo-slug>.md` under the parent. B3 audits each per-repo
plan; B5 dispatches each repo's own plan. This is **one plan per repo**, not one combined
plan (see mma-plan).

**Journal scoping.** Journal record + recall run against the parent journal with
`topic = <repo-slug>` (lowercase-kebab) so product-level knowledge slices per repo.

**One disposition governs the whole flow.** A contract carries exactly one `disposition` field
— never one per repo (a solution needing two delivery modes runs as two flows). Every involved
repository runs the SAME disposition's stages; only the underlying git or artifact signal is
evaluated per repository, exactly as the resume table already does ("every target repo has…",
"some repo has no…"):
- `pr` — every repo goes B4 → B5 → B6 → B7 → B8 → B9, each stage's condition checked against
  that repo's own branch/commit/PR/merge state.
- `commit-in-place` — every repo captures its own `commitBaseline`, then goes B5 → B6 → B7,
  committing directly on the branch already checked out. No B4, B8, or B9.
- `deliver-file` — no git required in any repo (a `deliver-file` contract is valid both inside
  and outside git). Each declared artifact resolves against the root ITS OWN entry names —
  `workspaceRoot`, or a named immediate child repository — never against a task's `cwd`. No B4,
  B8, or B9. A repo with no declared artifact simply has no B5 work.

Barrier per stage: finish a stage across ALL involved repos before advancing; LOCATE resumes at
the earliest stage not complete for all of them, using the SAME `*any*` and disposition rows for
the whole flow.

## Common: Artifact stem   (D1, D3, B2, backlog, branch, flow state, verifications)

One flow, one join key — the **stem** `<date>-<slug>`. `ls .mma/*/<stem>.*` and the
`mma/<slug>` branch recover the whole chain (exploration → spec → plan → backlog).

- **Minted once, at D1.** mma-explore derives `<slug>` from the topic title and stamps
  today's date; its SKILL.md owns the slug rule — mma-flow never restates or re-derives
  it. The exploration filename IS the stem, and the date is frozen here — a multi-day
  flow stays on one key.
- **Inherited by the workers, automatically — the flow threads no `outputPath`.** Each
  stage hands the prior dated artifact to the next as a `target.paths` source, so
  mma-spec and mma-plan reuse its stem verbatim server-side (see their SKILL.md
  `outputPath` rows). Undated scaffolds (the scratchpad `decisions.md`) are skipped, so
  only the exploration/spec dictates the stem. This is the SAME mechanism a direct
  skill call gets — the chain holds with or without the flow.
- **Read off disk for the artifacts no worker writes.** The main agent takes the
  stem from the most-recent exploration filename (once a spec exists, the spec filename
  is equally authoritative) to name the backlog `.mma/backlogs/<stem>.json`, the flow state
  `.mma/flow-state/<stem>.json`, the verification file `.mma/verifications/<stem>.json`, and the
  branch `mma/<slug>`. On resume, LOCATE recovers all of these the same way — off disk, no
  server-persisted state.

## Record Integration   (D1/D3, B2, B5, B6/B7, B10)

The Initiative record (the shared `initiatives.db` reached through the `mma_initiative_*` MCP
tools) SUPPLEMENTS this flow's caller-owned files — `.mma/verifications`, the backlog, contract
`state` — it never replaces them. mma-flow keeps writing those files exactly as documented
elsewhere in this skill; the Initiative record is an additional, durable, cross-repo view of the
same work for humans and Forge to query.

- **D1/D3** — Explore mints the artifact stem (Common: Artifact stem); Spec creates the
  Initiative (`mma_initiative_create`, keyed by the stem) and links this flow's workspace
  (`mma_initiative_link_workspace`) so every later record on this flow's Initiative resolves back
  to the repo(s) it targets.
- **B2** — Plan creates one durable Initiative Task per plan heading (`mma_initiative_task_create`),
  one dispatch per repo exactly as Plan itself fans out (Common: Multi-repo) — the durable Task
  ids are what B5's linkage and B6/B7's verification records point at.
- **B5** — Execute sends Initiative linkage on every execution dispatch: the `mma_run` request
  carries `initiative: { initiative: { uuid | human_key }, task_uuid, authorized_by }` so the
  engine links the terminal execution back to its Initiative Task in the same transaction as the
  terminal write — no separate call, no window where the two disagree.
- **B6/B7** — Review and Verify write `verification_record` rows (`mma_verification_record`)
  against the AcceptanceCriterion each checked, carrying the SAME `outcome.status` this flow
  already persists to `.mma/verifications/<stem>.json` (Common: Acceptance closure) — the
  Initiative record mirrors that evidence, it is not a second source of truth for it.
- **B10** — Journal + close reports the Initiative's own status with `initiative_status`
  (`mma_initiative_status`) once acceptance is closed, so the durable Initiative reflects the same
  `done` this flow's terminal report carries.

Caller-owned files remain authoritative for LOCATE and Common: Acceptance closure. The Initiative
record supplements them for cross-repo/cross-session visibility and never substitutes for
`.mma/verifications`, the backlog, or contract state.

**Lifecycle Engine mapping.** Six of this flow's stages also line up with the SPEC-004 Lifecycle
Engine's advisory phase/focus operations (`mma_initiative_phase_enter`, `mma_initiative_phase_satisfy`,
`mma_initiative_focus_set`) on that same Initiative:

- `D1 → phase_enter(discover)`
- `spec approval → phase_satisfy(refine)`
- `plan approval → phase_satisfy(design)`
- `B5 → focus_set(execute)`
- `B7 → phase_satisfy(verify)`
- `B10 → phase_satisfy(deliver) + focus_set(deliver)`

Each mapping is a caller action against the Initiative record — mma-flow (or the main agent
driving it) chooses to make the call, the same way it chooses every other Initiative write in
this section. The Lifecycle Engine only records what happened and reports an advisory gate
colour from it; it does not enforce this mapping, a transition sequence, the stage letters
above, execution admission, or a green gate. A phase left un-entered, satisfied out of order, or
never touched at all does not block any B-stage — LOCATE and Common: Approval remain the only
gates that do.

## Data model

All artifacts live under the **parent workspace**'s `.mma/` (the invocation cwd — the parent
in multi-repo mode, the single repo otherwise); sub-repos hold only branches, code, and PRs.

All share one `<stem>` = `<date>-<slug>`, minted at D1 (see Common: Artifact stem):

```text
.mma/explorations/<stem>.md            D1 — grounding; not needed once a spec exists
.mma/specs/<stem>.md                   D3 — one shared spec, carrying the contract at state: proposed
.mma/plans/<stem>--<repo-slug>.md      B2 — one plan PER involved repo (single repo: <stem>.md)
.mma/verifications/<stem>.json         B6/B7/human — every acceptance record, keyed by criterion
                                        id (Common: Acceptance closure); caller-owned, never
                                        written by the engine
.mma/flow-state/<stem>.json            commitBaseline (per repository, permits explicit null) +
                                        stageSkipped (Common: Clean start · Bounded non-progress) +
                                        routing.practice (Common: Practice routing);
                                        caller-owned, never written by the engine
.mma/backlogs/<stem>.json              lazy; uncommitted (see Common: Never-halt)
design/<stem>.md                       Forge durable design docs (only if that step runs)
```

No server schema, task type, or HTTP route is added — `/mma-flow` is client-side.

## Common: Practice routing   (B2, B5, B6, and any debug dispatch)

`practice` selects the TECHNIQUE the worker brings. It does not classify the deliverable, and the
engine never infers it — the caller declares it or the generic path runs. Omitting it is a real
choice with a real cost: the retained code technique (caller tracing, error paths, security sinks,
schema conformance, test adequacy; and for `debug`, stack-trace reading, bisection, test isolation,
reproduction of a failing test) ships behind this field and is unreachable without it.

**Decide once, at the first dispatch of the flow, and persist it.**

```jsonc
// .mma/flow-state/<stem>.json
{ "routing": { "practice": "software" } }   // omit `practice` entirely for the generic path
```

**The rule.** Set `practice: 'software'` **when code-level planning, implementation, review or
diagnosis technique is required** — NOT "when the artifact happens to be code". The distinction
decides the boundary cases: an n8n workflow's artifact is configuration, but reviewing its retries,
credential handling, idempotency and error paths needs software technique, so its flow sets
`software`. Terraform, SQL, notebooks and mixed code-and-configuration work are judged the same way.
A finance report, a policy memorandum or a written specification does not set it.

**Read that one persisted value on EVERY dispatch** of `plan` (B2), `execute_plan` (B5), `review`
(B6) and any `debug` dispatch, and send it verbatim:

```jsonc
{ "type": "plan", "practice": "software", "target": { "paths": ["..."] } }
```

Deciding per dispatch instead of reading the persisted value is the failure this section exists to
prevent: a flow that plans with the software technique and then reviews generically produces a plan
whose depth the review never checks, and nothing reports the mismatch. One flow, one value, every
dispatch.

`routing` sits OUTSIDE the contract digest and needs no approval — it is prompt routing, not an
agreement about quality, so changing it never invalidates an approval. `audit` never accepts
`practice`; it keeps its own `subtype`, which answers a different question (what is examined, not
what technique is brought).

## Failure handling

Never halts on content (see Common: Never-halt). Stops only on setup ambiguity, or on the two
named exceptions documented above:

- Design produced no spec yet → stop at the earliest incomplete Design stage.
- The contract is `proposed` or invalidated → `awaiting-approval` / `awaiting-reapproval`
  (Common: Approval) — a resumable wait, not a failure.
- A `human` criterion has no decision yet → `awaiting-human-verification` (Common: Acceptance
  closure) — a resumable wait, not a failure.
- A `human` criterion was recorded `rejected`, or Bounded non-progress forced a skip → the flow
  ends at `stopped-unmet-requirements` — an honest termination, not a `failed` result and not
  `done`.
- `pr` or `commit-in-place` started outside a git repository → stop before B1 (INV-3 rejects
  this disposition/cwd combination at contract validation).
- A target repo's path can't be resolved → ask the user once, then continue.
- `mma/<slug>` already exists and matches this flow → switch to it, rerun LOCATE.
- Branch-name collision with a different flow → stop, ask the user to resolve.
- `gh` missing/unauth for a repo at B8 → no progress this pass; Common: Bounded non-progress
  governs whether repeated no-progress ends the whole flow.
- `gh pr merge` fails for a repo at B9 → leave that PR open, merge the rest, note it.
