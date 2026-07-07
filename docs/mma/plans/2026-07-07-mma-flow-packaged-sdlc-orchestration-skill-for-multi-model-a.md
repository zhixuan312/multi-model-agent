# MMA Flow Packaged SDLC Orchestration Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `mma-flow` as a packaged MMA-native SDLC orchestration skill, including Claude Code workflow helpers, installer support, and discovery updates.

**Architecture:** Treat `mma-flow` as packaged content, not a new server endpoint: the `SKILL.md` is the authoritative cross-client playbook and four packaged workflow scripts provide Claude Code-only automation. Keep the only behavioral runtime change inside the Claude installer by teaching it to reconcile packaged `workflows/*.js` assets alongside `SKILL.md`, while the rest of the repository changes stay in skill packaging, tests, and discoverability docs.

**Tech Stack:** TypeScript and ESM for server code, packaged Markdown and JavaScript assets under `packages/server/src/skills/`, Vitest at the repo root via `pnpm vitest run`, package build via `pnpm build`, lint via `pnpm lint`.

**Ground truth at HEAD:**
- `packages/server/src/skills/mma-flow/` does not exist.
- `packages/server/src/skill-install/discover.ts` exports `SUPPORTED_SKILLS` with `17` entries ending at `mma-design`; `mma-flow` is absent.
- `packages/server/src/skill-install/skill-installers/claude-code.ts` exposes `installClaudeCode(opts)` and `uninstallClaudeCode(skillName, homeDir)` and only writes/removes `~/.claude/skills/<skillName>/SKILL.md`.
- `packages/server/src/cli/sync-skills.ts` already performs canonical upsert and orphan removal, but it tracks install state only through each skill directory’s `SKILL.md` version.
- `packages/server/src/skills/multi-model-agent/SKILL.md` is the packaged router skill and currently does not mention `mma-flow`.
- `tests/contract/skills/skill-frontmatter.test.ts` hardcodes the actionable skill list and currently excludes `mma-flow`.
- `tests/install/skill-manifest-sync.test.ts` hardcodes the current supported skill names and currently excludes `mma-flow`.
- `tests/skills/skill-validity.test.ts` automatically scans every directory under `packages/server/src/skills/`; any new `mma-flow/SKILL.md` must keep valid frontmatter, `version: "0.0.0-unreleased"`, and stay within the `<=320` line budget.
- The actual test runner is Vitest from the repo root: `pnpm vitest run ...`. The actual build/lint commands are `pnpm build` and `pnpm lint`.

**File Structure:**
```text
docs/mma/plans/2026-07-07-mma-flow-packaged-sdlc-orchestration-skill-for-multi-model-a.md    create

packages/server/src/skills/mma-flow/SKILL.md                                                   create
packages/server/src/skills/mma-flow/workflows/segment-spec-audit.js                            create
packages/server/src/skills/mma-flow/workflows/segment-plan-audit.js                            create
packages/server/src/skills/mma-flow/workflows/segment-review.js                                create
packages/server/src/skills/mma-flow/workflows/segment-execute.js                               create

packages/server/src/skill-install/skill-installers/claude-code.ts                              modify
packages/server/src/skill-install/discover.ts                                                  modify
packages/server/src/skills/multi-model-agent/SKILL.md                                          modify

tests/skills/mma-flow-audit-segments.test.ts                                                   create
tests/skills/mma-flow-build-segments.test.ts                                                   create
tests/skills/multi-model-agent-router.test.ts                                                  create
tests/cli/claude-code-writer.test.ts                                                           modify
tests/cli/sync-skills.test.ts                                                                  modify
tests/contract/skills/mma-flow-packaged-assets.test.ts                                         create
tests/contract/skills/skill-frontmatter.test.ts                                                modify
tests/install/skill-manifest-sync.test.ts                                                      modify
```

> Each task's final step is implicitly followed by a commit: once the task's tests are green, commit that task's files as a single focused commit (message referencing the task id, e.g. `I-3: install mma-flow workflows for claude-code (AC-2.1)`). One task, one commit — so the history is bisectable and each commit leaves the suite green.

# Prerequisite (workstream 1)

- [ ] No external artifact import is required. The historical local-only workflow assets are out of scope; implement directly from this spec and repo-local patterns.
- [ ] Confirm the worker stays on the repo root for every verification command in this plan: `/Users/zhangzhixuan/Documents/code/mma-parent/multi-model-agent/.mma/worktrees/1b9e25d4`.

# Implementation (workstream 2)

## Track 1: Packaged Orchestration Assets

### Task I-1: Author The `mma-flow` Playbook And Audit Segments (AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.8, AC-1.9, AC-1.10)

**Files:**
- Create: `packages/server/src/skills/mma-flow/SKILL.md`
- Create: `packages/server/src/skills/mma-flow/workflows/segment-spec-audit.js`
- Create: `packages/server/src/skills/mma-flow/workflows/segment-plan-audit.js`
- Test: `tests/skills/mma-flow-audit-segments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

const skillPath = path.resolve('packages/server/src/skills/mma-flow/SKILL.md');
const specSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-spec-audit.js');
const planSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-plan-audit.js');

describe('mma-flow audit playbook assets', () => {
  it('publishes the playbook frontmatter and stage order without superpowers references', async () => {
    const raw = readFileSync(skillPath, 'utf8');
    const { data, content } = matter(raw);

    expect(data.name).toBe('mma-flow');
    expect(String(data.description)).toMatch(/^Use when\b/);
    expect(data.version).toBe('0.0.0-unreleased');
    expect(content).toContain('Stage 0 LOCATE');
    expect(content).toContain('D1 `mma-design`');
    expect(content).toContain('D2 `mma-spec`');
    for (const stage of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']) {
      expect(content).toContain(stage);
    }
    expect(content).toContain('docs/mma/specs/');
    expect(content).toContain('docs/mma/plans/');
    expect(content).toContain('mma/<slug>');
    expect(content).toContain('gh pr create --base');
    expect(content).toContain('Deferred-Decision Ledger');
    expect(raw).not.toContain('superpowers:');
  });

  it('runs the spec audit loop with early exit on a clean first round', async () => {
    const { runSegmentSpecAudit } = await import(specSegmentPath);
    const calls: string[] = [];
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: { skill: string }) => {
        calls.push(request.skill);
        return {
          findingsSummary: 'clean',
          findings: [],
          counts: { critical: 0, high: 0, medium: 0, low: 0 },
          contextBlockId: 'cb-spec-clean',
        };
      },
    };

    const result = await runSegmentSpecAudit(
      { specPath: '/tmp/spec.md', cwd: '/repo', autofix: true, cap: 3 },
      runtime,
    );

    expect(result).toEqual({
      specPath: '/tmp/spec.md',
      cwd: '/repo',
      roundsRun: 1,
      clean: true,
      rounds: [
        {
          round: 1,
          findingsSummary: 'clean',
          criticalCount: 0,
          highCount: 0,
          mediumCount: 0,
          lowCount: 0,
          fixedByAgent: false,
          contextBlockId: 'cb-spec-clean',
        },
      ],
      openFindings: [],
      blockingRemaining: false,
      proceed: true,
      note: 'Spec audit cleared in round 1.',
      contextBlockId: 'cb-spec-clean',
    });
    expect(calls).toEqual(['mma-audit']);
  });

  it('caps the spec audit loop at three rounds and blocks when critical findings remain', async () => {
    const { runSegmentSpecAudit } = await import(specSegmentPath);
    let audits = 0;
    let fixes = 0;
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: { skill: string }) => {
        if (request.skill === 'mma-audit') {
          audits += 1;
          return {
            findingsSummary: `round ${audits}`,
            findings: [`critical-${audits}`],
            counts: { critical: 1, high: 0, medium: 0, low: 0 },
            contextBlockId: `cb-spec-${audits}`,
          };
        }
        fixes += 1;
        return { applied: true };
      },
    };

    const result = await runSegmentSpecAudit(
      { specPath: '/tmp/spec.md', cwd: '/repo', autofix: true, cap: 3 },
      runtime,
    );

    expect(audits).toBe(3);
    expect(fixes).toBe(2);
    expect(result.roundsRun).toBe(3);
    expect(result.clean).toBe(false);
    expect(result.blockingRemaining).toBe(true);
    expect(result.proceed).toBe(false);
    expect(result.openFindings).toEqual(['critical-3']);
    expect(result.note).toContain('Critical or high findings remain after round 3');
  });

  it('runs the plan audit loop with the same shared policy shape', async () => {
    const { runSegmentPlanAudit } = await import(planSegmentPath);
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async () => ({
        findingsSummary: 'plan clean',
        findings: [],
        counts: { critical: 0, high: 0, medium: 1, low: 2 },
        contextBlockId: 'cb-plan-clean',
      }),
    };

    const result = await runSegmentPlanAudit(
      { planPath: '/tmp/plan.md', cwd: '/repo', autofix: false, cap: 3 },
      runtime,
    );

    expect(result.planPath).toBe('/tmp/plan.md');
    expect(result.cwd).toBe('/repo');
    expect(result.roundsRun).toBe(1);
    expect(result.clean).toBe(true);
    expect(result.proceed).toBe(true);
    expect(result.blockingRemaining).toBe(false);
    expect(result.rounds[0]).toMatchObject({
      round: 1,
      findingsSummary: 'plan clean',
      criticalCount: 0,
      highCount: 0,
      mediumCount: 1,
      lowCount: 2,
      fixedByAgent: false,
      contextBlockId: 'cb-plan-clean',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/skills/mma-flow-audit-segments.test.ts`
Expected: FAIL with `ENOENT` for `packages/server/src/skills/mma-flow/SKILL.md` and missing module errors for the two workflow scripts.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/skills/mma-flow/SKILL.md` with this complete content:

```md
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
```

Create `packages/server/src/skills/mma-flow/workflows/segment-spec-audit.js` with this complete content:

```js
const DEFAULT_CAP = 3;

function phaseRunner(runtime) {
  return typeof runtime.phase === 'function'
    ? runtime.phase.bind(runtime)
    : async (_name, fn) => fn();
}

function logger(runtime) {
  return typeof runtime.log === 'function' ? runtime.log.bind(runtime) : () => undefined;
}

function severityCounts(result) {
  const counts = result?.counts ?? {};
  return {
    critical: Number(counts.critical ?? 0),
    high: Number(counts.high ?? 0),
    medium: Number(counts.medium ?? 0),
    low: Number(counts.low ?? 0),
  };
}

function normalizeCap(cap) {
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP;
}

function makeRound(round, auditResult, fixedByAgent) {
  const counts = severityCounts(auditResult);
  return {
    round,
    findingsSummary: String(auditResult?.findingsSummary ?? ''),
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    fixedByAgent,
    contextBlockId: auditResult?.contextBlockId ?? null,
  };
}

function isClean(round) {
  return round.criticalCount === 0 && round.highCount === 0;
}

export async function runSegmentSpecAudit(args, runtime = globalThis) {
  const cwd = args.cwd ?? process.cwd();
  const cap = normalizeCap(args.cap);
  const rounds = [];
  let latestContextBlockId = args.contextBlockId ?? null;
  const runPhase = phaseRunner(runtime);
  const log = logger(runtime);

  for (let roundNumber = 1; roundNumber <= cap; roundNumber += 1) {
    const auditResult = await runPhase(`spec-audit-${roundNumber}`, () => runtime.agent({
      skill: 'mma-audit',
      subtype: 'spec',
      cwd,
      targetPath: args.specPath,
      contextBlockId: latestContextBlockId,
    }));

    latestContextBlockId = auditResult?.contextBlockId ?? latestContextBlockId;
    const round = makeRound(roundNumber, auditResult, false);
    rounds.push(round);

    if (isClean(round)) {
      log(`Spec audit cleared in round ${roundNumber}.`);
      return {
        specPath: args.specPath,
        cwd,
        roundsRun: roundNumber,
        clean: true,
        rounds,
        openFindings: [],
        blockingRemaining: false,
        proceed: true,
        note: `Spec audit cleared in round ${roundNumber}.`,
        contextBlockId: latestContextBlockId,
      };
    }

    if (args.autofix !== false && roundNumber < cap) {
      await runPhase(`spec-audit-fix-${roundNumber}`, () => runtime.agent({
        skill: 'mma-delegate',
        cwd,
        prompt: `Resolve the critical/high spec audit findings for ${args.specPath}.`,
        contextBlockIds: latestContextBlockId ? [latestContextBlockId] : [],
      }));
      rounds[rounds.length - 1] = { ...round, fixedByAgent: true };
      continue;
    }
  }

  const finalRound = rounds[rounds.length - 1];
  return {
    specPath: args.specPath,
    cwd,
    roundsRun: rounds.length,
    clean: false,
    rounds,
    openFindings: finalRound ? [finalRound.findingsSummary].filter(Boolean) : [],
    blockingRemaining: true,
    proceed: false,
    note: `Critical or high findings remain after round ${rounds.length}.`,
    contextBlockId: latestContextBlockId,
  };
}

export default async function main(args, runtime = globalThis) {
  return runSegmentSpecAudit(args, runtime);
}
```

Create `packages/server/src/skills/mma-flow/workflows/segment-plan-audit.js` with this complete content:

```js
const DEFAULT_CAP = 3;

function phaseRunner(runtime) {
  return typeof runtime.phase === 'function'
    ? runtime.phase.bind(runtime)
    : async (_name, fn) => fn();
}

function logger(runtime) {
  return typeof runtime.log === 'function' ? runtime.log.bind(runtime) : () => undefined;
}

function severityCounts(result) {
  const counts = result?.counts ?? {};
  return {
    critical: Number(counts.critical ?? 0),
    high: Number(counts.high ?? 0),
    medium: Number(counts.medium ?? 0),
    low: Number(counts.low ?? 0),
  };
}

function normalizeCap(cap) {
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP;
}

function makeRound(round, auditResult, fixedByAgent) {
  const counts = severityCounts(auditResult);
  return {
    round,
    findingsSummary: String(auditResult?.findingsSummary ?? ''),
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    fixedByAgent,
    contextBlockId: auditResult?.contextBlockId ?? null,
  };
}

function isClean(round) {
  return round.criticalCount === 0 && round.highCount === 0;
}

export async function runSegmentPlanAudit(args, runtime = globalThis) {
  const cwd = args.cwd;
  const cap = normalizeCap(args.cap);
  const rounds = [];
  let latestContextBlockId = args.contextBlockId ?? null;
  const runPhase = phaseRunner(runtime);
  const log = logger(runtime);

  for (let roundNumber = 1; roundNumber <= cap; roundNumber += 1) {
    const auditResult = await runPhase(`plan-audit-${roundNumber}`, () => runtime.agent({
      skill: 'mma-audit',
      subtype: 'plan',
      cwd,
      targetPath: args.planPath,
      contextBlockId: latestContextBlockId,
    }));

    latestContextBlockId = auditResult?.contextBlockId ?? latestContextBlockId;
    const round = makeRound(roundNumber, auditResult, false);
    rounds.push(round);

    if (isClean(round)) {
      log(`Plan audit cleared in round ${roundNumber}.`);
      return {
        planPath: args.planPath,
        cwd,
        roundsRun: roundNumber,
        clean: true,
        rounds,
        openFindings: [],
        blockingRemaining: false,
        proceed: true,
        note: `Plan audit cleared in round ${roundNumber}.`,
        contextBlockId: latestContextBlockId,
      };
    }

    if (args.autofix !== false && roundNumber < cap) {
      await runPhase(`plan-audit-fix-${roundNumber}`, () => runtime.agent({
        skill: 'mma-delegate',
        cwd,
        prompt: `Resolve the critical/high plan audit findings for ${args.planPath}.`,
        contextBlockIds: latestContextBlockId ? [latestContextBlockId] : [],
      }));
      rounds[rounds.length - 1] = { ...round, fixedByAgent: true };
      continue;
    }
  }

  const finalRound = rounds[rounds.length - 1];
  return {
    planPath: args.planPath,
    cwd,
    roundsRun: rounds.length,
    clean: false,
    rounds,
    openFindings: finalRound ? [finalRound.findingsSummary].filter(Boolean) : [],
    blockingRemaining: true,
    proceed: false,
    note: `Critical or high findings remain after round ${rounds.length}.`,
    contextBlockId: latestContextBlockId,
  };
}

export default async function main(args, runtime = globalThis) {
  return runSegmentPlanAudit(args, runtime);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/skills/mma-flow-audit-segments.test.ts`
Expected: PASS

### Task I-2: Author The Review And Execute Segments (AC-1.3, AC-1.6, AC-1.7)

**Files:**
- Create: `packages/server/src/skills/mma-flow/workflows/segment-review.js`
- Create: `packages/server/src/skills/mma-flow/workflows/segment-execute.js`
- Test: `tests/skills/mma-flow-build-segments.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const reviewSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-review.js');
const executeSegmentPath = path.resolve('packages/server/src/skills/mma-flow/workflows/segment-execute.js');

describe('mma-flow build segments', () => {
  it('reviews the source-branch diff with the shared three-round policy', async () => {
    const { buildCompareRange, runSegmentReview } = await import(reviewSegmentPath);
    expect(buildCompareRange('main')).toBe('main...HEAD');

    let reviews = 0;
    let fixes = 0;
    const runtime = {
      log: () => undefined,
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: { skill: string }) => {
        if (request.skill === 'mma-review') {
          reviews += 1;
          return reviews === 1
            ? {
                findingsSummary: 'needs review fixes',
                findings: ['critical diff bug'],
                counts: { critical: 1, high: 0, medium: 0, low: 0 },
                contextBlockId: 'cb-review-1',
              }
            : {
                findingsSummary: 'clean review',
                findings: [],
                counts: { critical: 0, high: 0, medium: 1, low: 0 },
                contextBlockId: 'cb-review-2',
              };
        }
        fixes += 1;
        return { applied: true };
      },
    };

    const result = await runSegmentReview(
      { cwd: '/repo', sourceBranch: 'main', autofix: true, cap: 3 },
      runtime,
    );

    expect(fixes).toBe(1);
    expect(result.roundsRun).toBe(2);
    expect(result.clean).toBe(true);
    expect(result.proceed).toBe(true);
    expect(result.blockingRemaining).toBe(false);
    expect(result.sourceBranch).toBe('main');
    expect(result.rounds.map((round: { fixedByAgent: boolean }) => round.fixedByAgent)).toEqual([true, false]);
  });

  it('normalizes branch slugs and falls back to task for empty titles', async () => {
    const { slugifySpecTitle } = await import(executeSegmentPath);

    expect(slugifySpecTitle('Cache / Queue parity!')).toBe('cache-queue-parity');
    expect(slugifySpecTitle('***')).toBe('task');
    expect(slugifySpecTitle('A very long title that should truncate after thirty characters total')).toBe('a-very-long-title-that-should');
  });

  it('maps locate signals to the earliest incomplete stage', async () => {
    const { pickResumeStage } = await import(executeSegmentPath);

    expect(pickResumeStage({
      latestSpecPath: null,
      latestPlanPath: null,
      gitRepoPresent: false,
      sourceBranch: null,
      projectBranch: null,
      projectBranchHasUniqueCommits: false,
      prExists: false,
      prMerged: false,
      deferredDecisionLedgerHasItems: false,
      currentSessionEvidence: { reviewPassed: false, wholeRepoGreen: false },
    })).toBe('D1');

    expect(pickResumeStage({
      latestSpecPath: 'docs/mma/specs/2026-07-07-demo.md',
      latestPlanPath: null,
      gitRepoPresent: false,
      sourceBranch: null,
      projectBranch: null,
      projectBranchHasUniqueCommits: false,
      prExists: false,
      prMerged: false,
      deferredDecisionLedgerHasItems: false,
      currentSessionEvidence: { reviewPassed: false, wholeRepoGreen: false },
    })).toBe('B1');

    expect(pickResumeStage({
      latestSpecPath: 'docs/mma/specs/2026-07-07-demo.md',
      latestPlanPath: 'docs/mma/plans/2026-07-07-demo.md',
      gitRepoPresent: true,
      sourceBranch: 'main',
      projectBranch: 'mma/demo',
      projectBranchHasUniqueCommits: true,
      prExists: false,
      prMerged: false,
      deferredDecisionLedgerHasItems: false,
      currentSessionEvidence: { reviewPassed: true, wholeRepoGreen: false },
    })).toBe('B7');
  });

  it('forwards grouped execute-plan dispatch on the current branch', async () => {
    const { runSegmentExecute } = await import(executeSegmentPath);
    const calls: Array<Record<string, unknown>> = [];
    const runtime = {
      phase: async (_name: string, fn: () => Promise<unknown>) => fn(),
      agent: async (request: Record<string, unknown>) => {
        calls.push(request);
        return { ok: true, taskId: 'task-123' };
      },
    };

    const result = await runSegmentExecute(
      { cwd: '/repo', planPath: '/repo/docs/mma/plans/demo.md', contextBlockIds: ['cb-1', 'cb-2'] },
      runtime,
    );

    expect(calls).toEqual([
      {
        skill: 'mma-execute-plan',
        cwd: '/repo',
        planPath: '/repo/docs/mma/plans/demo.md',
        contextBlockIds: ['cb-1', 'cb-2'],
      },
    ]);
    expect(result).toEqual({ ok: true, taskId: 'task-123' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/skills/mma-flow-build-segments.test.ts`
Expected: FAIL with missing module errors for `segment-review.js` and `segment-execute.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/skills/mma-flow/workflows/segment-review.js` with this complete content:

```js
const DEFAULT_CAP = 3;

function phaseRunner(runtime) {
  return typeof runtime.phase === 'function'
    ? runtime.phase.bind(runtime)
    : async (_name, fn) => fn();
}

function logger(runtime) {
  return typeof runtime.log === 'function' ? runtime.log.bind(runtime) : () => undefined;
}

function severityCounts(result) {
  const counts = result?.counts ?? {};
  return {
    critical: Number(counts.critical ?? 0),
    high: Number(counts.high ?? 0),
    medium: Number(counts.medium ?? 0),
    low: Number(counts.low ?? 0),
  };
}

function normalizeCap(cap) {
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP;
}

export function buildCompareRange(sourceBranch) {
  return `${sourceBranch}...HEAD`;
}

function makeRound(round, reviewResult, fixedByAgent) {
  const counts = severityCounts(reviewResult);
  return {
    round,
    findingsSummary: String(reviewResult?.findingsSummary ?? ''),
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    fixedByAgent,
    contextBlockId: reviewResult?.contextBlockId ?? null,
  };
}

function isClean(round) {
  return round.criticalCount === 0 && round.highCount === 0;
}

export async function runSegmentReview(args, runtime = globalThis) {
  const cap = normalizeCap(args.cap);
  const rounds = [];
  let latestContextBlockId = args.contextBlockId ?? null;
  const runPhase = phaseRunner(runtime);
  const log = logger(runtime);

  for (let roundNumber = 1; roundNumber <= cap; roundNumber += 1) {
    const reviewResult = await runPhase(`code-review-${roundNumber}`, () => runtime.agent({
      skill: 'mma-review',
      cwd: args.cwd,
      compareRange: buildCompareRange(args.sourceBranch),
      contextBlockId: latestContextBlockId,
    }));

    latestContextBlockId = reviewResult?.contextBlockId ?? latestContextBlockId;
    const round = makeRound(roundNumber, reviewResult, false);
    rounds.push(round);

    if (isClean(round)) {
      log(`Code review cleared in round ${roundNumber}.`);
      return {
        cwd: args.cwd,
        sourceBranch: args.sourceBranch,
        roundsRun: roundNumber,
        clean: true,
        rounds,
        openFindings: [],
        blockingRemaining: false,
        proceed: true,
        note: `Code review cleared in round ${roundNumber}.`,
        contextBlockId: latestContextBlockId,
      };
    }

    if (args.autofix !== false && roundNumber < cap) {
      await runPhase(`code-review-fix-${roundNumber}`, () => runtime.agent({
        skill: 'mma-delegate',
        cwd: args.cwd,
        prompt: `Resolve the critical/high code review findings for the diff ${buildCompareRange(args.sourceBranch)}.`,
        contextBlockIds: latestContextBlockId ? [latestContextBlockId] : [],
      }));
      rounds[rounds.length - 1] = { ...round, fixedByAgent: true };
      continue;
    }
  }

  const finalRound = rounds[rounds.length - 1];
  return {
    cwd: args.cwd,
    sourceBranch: args.sourceBranch,
    roundsRun: rounds.length,
    clean: false,
    rounds,
    openFindings: finalRound ? [finalRound.findingsSummary].filter(Boolean) : [],
    blockingRemaining: true,
    proceed: false,
    note: `Critical or high findings remain after round ${rounds.length}.`,
    contextBlockId: latestContextBlockId,
  };
}

export default async function main(args, runtime = globalThis) {
  return runSegmentReview(args, runtime);
}
```

Create `packages/server/src/skills/mma-flow/workflows/segment-execute.js` with this complete content:

```js
export function slugifySpecTitle(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
    .replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : 'task';
}

export function pickResumeStage(signals) {
  if (!signals.latestSpecPath) return 'D1';
  if (!signals.latestPlanPath) return 'B1';
  if (!signals.projectBranch) return 'B3';
  if (!signals.projectBranchHasUniqueCommits) return 'B5';
  if (!signals.currentSessionEvidence.reviewPassed) return 'B6';
  if (!signals.currentSessionEvidence.wholeRepoGreen) return 'B7';
  if (!signals.prExists) return 'B8';
  if (!signals.prMerged) return 'B9';
  return 'COMPLETE';
}

function phaseRunner(runtime) {
  return typeof runtime.phase === 'function'
    ? runtime.phase.bind(runtime)
    : async (_name, fn) => fn();
}

export async function runSegmentExecute(args, runtime = globalThis) {
  const runPhase = phaseRunner(runtime);
  return runPhase('execute-plan', () => runtime.agent({
    skill: 'mma-execute-plan',
    cwd: args.cwd,
    planPath: args.planPath,
    contextBlockIds: args.contextBlockIds ?? [],
  }));
}

export default async function main(args, runtime = globalThis) {
  return runSegmentExecute(args, runtime);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/skills/mma-flow-build-segments.test.ts`
Expected: PASS

> **Track 1 verification subset (run after I-1 → I-2 land, before moving to Track 2):**
> `pnpm vitest run tests/skills/mma-flow-audit-segments.test.ts tests/skills/mma-flow-build-segments.test.ts tests/skills/skill-validity.test.ts`
> Expected: PASS. Incremental checkpoint only; the Full-suite gate still runs the whole suite.

## Track 2: Claude Code Workflow Installation

### Task I-3: Copy Packaged Workflow Scripts During Claude Skill Install (AC-2.1)

**Files:**
- Modify: `packages/server/src/skill-install/skill-installers/claude-code.ts`
- Test: `tests/cli/claude-code-writer.test.ts`

- [ ] **Step 1: Write the failing test**

Add these cases to `tests/cli/claude-code-writer.test.ts`:

```ts
it('copies packaged workflow files into <homeDir>/.claude/workflows/', () => {
  const homeDir = makeFakeHome();
  const skillsRoot = makeFakeSkillsRoot();
  const workflowDir = path.join(skillsRoot, 'mma-flow', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, 'segment-spec-audit.js'), 'export default 1;\n', 'utf8');
  writeFileSync(path.join(workflowDir, 'segment-plan-audit.js'), 'export default 2;\n', 'utf8');

  try {
    installClaudeCode({
      skillName: 'mma-flow',
      content: '# mma-flow\n',
      homeDir,
      skillsRoot,
    });

    expect(readFileSync(path.join(homeDir, '.claude', 'workflows', 'segment-spec-audit.js'), 'utf8')).toBe('export default 1;\n');
    expect(readFileSync(path.join(homeDir, '.claude', 'workflows', 'segment-plan-audit.js'), 'utf8')).toBe('export default 2;\n');
  } finally {
    rmFakeDir(homeDir);
    rmFakeDir(skillsRoot);
  }
});

it('skips workflow installation when the packaged skill has no workflows directory', () => {
  const homeDir = makeFakeHome();
  const skillsRoot = makeFakeSkillsRoot();

  try {
    installClaudeCode({
      skillName: 'mma-plan',
      content: '# mma-plan\n',
      homeDir,
      skillsRoot,
    });

    expect(existsSync(path.join(homeDir, '.claude', 'workflows'))).toBe(false);
  } finally {
    rmFakeDir(homeDir);
    rmFakeDir(skillsRoot);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/cli/claude-code-writer.test.ts`
Expected: FAIL because `installClaudeCode()` currently writes only `SKILL.md` and never creates `~/.claude/workflows/`.

- [ ] **Step 3: Write minimal implementation**

Apply this exact patch to `packages/server/src/skill-install/skill-installers/claude-code.ts`:

```diff
@@
 import fs from 'node:fs';
 import path from 'node:path';
@@
 export interface ClaudeCodeInstallOpts {
   skillName: string;
   content: string;
   homeDir: string;
   skillsRoot: string;
   authToken?: string;
 }
+
+function workflowDirFor(homeDir: string): string {
+  return path.join(homeDir, '.claude', 'workflows');
+}
+
+function workflowManifestPath(homeDir: string, skillName: string): string {
+  return path.join(workflowDirFor(homeDir), `.${skillName}.json`);
+}
+
+function packagedWorkflowDir(skillsRoot: string, skillName: string): string {
+  return path.join(skillsRoot, skillName, 'workflows');
+}
+
+function listPackagedWorkflowFiles(skillsRoot: string, skillName: string): string[] {
+  const dir = packagedWorkflowDir(skillsRoot, skillName);
+  try {
+    return fs.readdirSync(dir)
+      .filter((fileName) => fileName.endsWith('.js'))
+      .sort();
+  } catch {
+    return [];
+  }
+}
+
+function writeWorkflowManifest(homeDir: string, skillName: string, files: string[]): void {
+  if (files.length === 0) return;
+  fs.mkdirSync(workflowDirFor(homeDir), { recursive: true });
+  fs.writeFileSync(
+    workflowManifestPath(homeDir, skillName),
+    JSON.stringify({ skillName, files }, null, 2) + '\n',
+    'utf-8',
+  );
+}
+
+function syncPackagedWorkflows(homeDir: string, skillsRoot: string, skillName: string): void {
+  const fileNames = listPackagedWorkflowFiles(skillsRoot, skillName);
+  if (fileNames.length === 0) return;
+
+  const targetDir = workflowDirFor(homeDir);
+  fs.mkdirSync(targetDir, { recursive: true });
+
+  for (const fileName of fileNames) {
+    const sourcePath = path.join(packagedWorkflowDir(skillsRoot, skillName), fileName);
+    const targetPath = path.join(targetDir, fileName);
+    fs.copyFileSync(sourcePath, targetPath);
+  }
+
+  writeWorkflowManifest(homeDir, skillName, fileNames);
+}
@@
 export function installClaudeCode(opts: ClaudeCodeInstallOpts): void {
   const { skillName, content, homeDir, skillsRoot, authToken } = opts;
@@
   const skillDir = path.join(homeDir, '.claude', 'skills', skillName);
   fs.mkdirSync(skillDir, { recursive: true });
   fs.writeFileSync(path.join(skillDir, 'SKILL.md'), inlinedContent, 'utf-8');
+  syncPackagedWorkflows(homeDir, skillsRoot, skillName);
 }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/cli/claude-code-writer.test.ts`
Expected: PASS

### Task I-4: Reconcile Stale Claude Workflows And Prove `sync-skills` Target Behavior (AC-2.1, AC-2.2, AC-2.3)

**Files:**
- Modify: `packages/server/src/skill-install/skill-installers/claude-code.ts`
- Test: `tests/cli/claude-code-writer.test.ts`
- Test: `tests/cli/sync-skills.test.ts`

- [ ] **Step 1: Write the failing test**

Add these cases:

```ts
it('removes stale packaged workflow files for the same skill during reinstall and uninstall', () => {
  const homeDir = makeFakeHome();
  const skillsRoot = makeFakeSkillsRoot();
  const workflowDir = path.join(skillsRoot, 'mma-flow', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, 'segment-spec-audit.js'), 'export default "one";\n', 'utf8');
  writeFileSync(path.join(workflowDir, 'segment-plan-audit.js'), 'export default "two";\n', 'utf8');

  try {
    installClaudeCode({
      skillName: 'mma-flow',
      content: '# mma-flow\n',
      homeDir,
      skillsRoot,
    });

    rmSync(path.join(workflowDir, 'segment-plan-audit.js'));
    installClaudeCode({
      skillName: 'mma-flow',
      content: '# mma-flow\n',
      homeDir,
      skillsRoot,
    });

    expect(existsSync(path.join(homeDir, '.claude', 'workflows', 'segment-spec-audit.js'))).toBe(true);
    expect(existsSync(path.join(homeDir, '.claude', 'workflows', 'segment-plan-audit.js'))).toBe(false);

    uninstallClaudeCode('mma-flow', homeDir);
    expect(existsSync(path.join(homeDir, '.claude', 'workflows', 'segment-spec-audit.js'))).toBe(false);
  } finally {
    rmFakeDir(homeDir);
    rmFakeDir(skillsRoot);
  }
});
```

And add this integration block to `tests/cli/sync-skills.test.ts`:

```ts
describe('sync-skills — mma-flow workflows', () => {
  it('installs workflow helpers for claude-code but not for codex', async () => {
    const home = makeFakeHome();
    const skillsRoot = makeFakeSkillsRoot(Object.fromEntries(SUPPORTED_SKILLS.map((skill) => [skill, '4.0.2'])));
    const workflowDir = path.join(skillsRoot, 'mma-flow', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, 'segment-spec-audit.js'), 'export default "spec";\n', 'utf8');
    writeFileSync(path.join(workflowDir, 'segment-plan-audit.js'), 'export default "plan";\n', 'utf8');
    writeFileSync(path.join(workflowDir, 'segment-review.js'), 'export default "review";\n', 'utf8');
    writeFileSync(path.join(workflowDir, 'segment-execute.js'), 'export default "execute";\n', 'utf8');

    try {
      expect(await runSyncSkills({ argv: ['--target=claude-code'], homeDir: home, skillsRoot, stdout: () => true })).toBe(0);
      expect(existsSync(path.join(home, '.claude', 'workflows', 'segment-review.js'))).toBe(true);

      expect(await runSyncSkills({ argv: ['--target=codex'], homeDir: home, skillsRoot, stdout: () => true })).toBe(0);
      expect(existsSync(path.join(home, '.codex', 'workflows', 'segment-review.js'))).toBe(false);
    } finally {
      removeFakeHome(home);
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/cli/claude-code-writer.test.ts tests/cli/sync-skills.test.ts`
Expected: FAIL because stale workflow files are not removed and `uninstallClaudeCode()` leaves workflow artifacts behind.

- [ ] **Step 3: Write minimal implementation**

Apply this exact patch to `packages/server/src/skill-install/skill-installers/claude-code.ts`:

```diff
@@
 function workflowManifestPath(homeDir: string, skillName: string): string {
   return path.join(workflowDirFor(homeDir), `.${skillName}.json`);
 }
+
+function readWorkflowManifest(homeDir: string, skillName: string): string[] {
+  try {
+    const raw = fs.readFileSync(workflowManifestPath(homeDir, skillName), 'utf-8');
+    const parsed = JSON.parse(raw) as { files?: string[] };
+    return Array.isArray(parsed.files) ? parsed.files.filter((fileName) => typeof fileName === 'string') : [];
+  } catch {
+    return [];
+  }
+}
@@
 function syncPackagedWorkflows(homeDir: string, skillsRoot: string, skillName: string): void {
   const fileNames = listPackagedWorkflowFiles(skillsRoot, skillName);
-  if (fileNames.length === 0) return;
+  const previousFiles = readWorkflowManifest(homeDir, skillName);
+  const targetDir = workflowDirFor(homeDir);
 
-  const targetDir = workflowDirFor(homeDir);
-  fs.mkdirSync(targetDir, { recursive: true });
+  if (fileNames.length === 0) {
+    for (const stale of previousFiles) {
+      fs.rmSync(path.join(targetDir, stale), { force: true });
+    }
+    fs.rmSync(workflowManifestPath(homeDir, skillName), { force: true });
+    return;
+  }
+
+  fs.mkdirSync(targetDir, { recursive: true });
+
+  for (const stale of previousFiles) {
+    if (!fileNames.includes(stale)) {
+      fs.rmSync(path.join(targetDir, stale), { force: true });
+    }
+  }
@@
 export function uninstallClaudeCode(skillName: string, homeDir: string): void {
   const skillsBase = path.resolve(homeDir, '.claude', 'skills');
+  const targetDir = workflowDirFor(homeDir);
+  for (const fileName of readWorkflowManifest(homeDir, skillName)) {
+    fs.rmSync(path.join(targetDir, fileName), { force: true });
+  }
+  fs.rmSync(workflowManifestPath(homeDir, skillName), { force: true });
@@
   fs.rmSync(resolvedSkillDir, { recursive: true, force: true });
 }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/cli/claude-code-writer.test.ts tests/cli/sync-skills.test.ts`
Expected: PASS

> **Track 2 verification subset (run after I-3 → I-4 land, before moving to Track 3):**
> `pnpm vitest run tests/cli/claude-code-writer.test.ts tests/cli/sync-skills.test.ts`
> Expected: PASS. Incremental checkpoint only; the Full-suite gate still runs the whole suite.

## Track 3: Discovery And Router Exposure

### Task I-5: Add `mma-flow` To Shipped Skill Discovery And Contract Coverage (AC-3.1, AC-4.1)

**Files:**
- Modify: `packages/server/src/skill-install/discover.ts`
- Test: `tests/contract/skills/mma-flow-packaged-assets.test.ts`
- Test: `tests/contract/skills/skill-frontmatter.test.ts`
- Test: `tests/install/skill-manifest-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/contract/skills/mma-flow-packaged-assets.test.ts` with this complete content:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SUPPORTED_SKILLS } from '../../../packages/server/src/skill-install/discover.js';

const root = path.resolve('packages/server/src/skills/mma-flow');
const files = [
  path.join(root, 'SKILL.md'),
  path.join(root, 'workflows', 'segment-spec-audit.js'),
  path.join(root, 'workflows', 'segment-plan-audit.js'),
  path.join(root, 'workflows', 'segment-review.js'),
  path.join(root, 'workflows', 'segment-execute.js'),
];

describe('contract: mma-flow packaged assets', () => {
  it('adds mma-flow to SUPPORTED_SKILLS', () => {
    expect(SUPPORTED_SKILLS).toContain('mma-flow');
  });

  it('ships the expected packaged files with no superpowers references', () => {
    for (const filePath of files) {
      expect(existsSync(filePath), filePath).toBe(true);
      expect(readFileSync(filePath, 'utf8')).not.toContain('superpowers:');
    }
  });

  it('loads each workflow file as valid ESM JavaScript', async () => {
    for (const filePath of files.slice(1)) {
      const mod = await import(pathToFileURL(filePath).href);
      expect(mod).toBeTruthy();
    }
  });
});
```

Update `tests/contract/skills/skill-frontmatter.test.ts` so `ACTIONABLE_SKILLS` includes `'mma-flow'`.

Update `tests/install/skill-manifest-sync.test.ts` so its explicit supported-skill fixture appends `'mma-flow'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/contract/skills/mma-flow-packaged-assets.test.ts tests/contract/skills/skill-frontmatter.test.ts tests/install/skill-manifest-sync.test.ts`
Expected: FAIL because `SUPPORTED_SKILLS` does not include `mma-flow` and the hardcoded contract arrays still reflect the old 17-skill bundle.

- [ ] **Step 3: Write minimal implementation**

Apply this exact patch to `packages/server/src/skill-install/discover.ts`:

```diff
@@
 export const SUPPORTED_SKILLS = [
   'multi-model-agent',
   'mma-delegate',
   'mma-audit',
   'mma-review',
   'mma-debug',
   'mma-execute-plan',
   'mma-retry',
   'mma-context-blocks',
   'mma-investigate',
   'mma-research',
   'mma-explore',
   'mma-journal-record',
   'mma-journal-recall',
   'mma-orchestrate',
   'mma-spec',
   'mma-plan',
   'mma-design',
+  'mma-flow',
 ] as const;
```

Update `tests/contract/skills/skill-frontmatter.test.ts` so `ACTIONABLE_SKILLS` becomes:

```ts
const ACTIONABLE_SKILLS = [
  'mma-audit',
  'mma-context-blocks',
  'mma-debug',
  'mma-delegate',
  'mma-design',
  'mma-execute-plan',
  'mma-explore',
  'mma-flow',
  'mma-journal-record',
  'mma-journal-recall',
  'mma-orchestrate',
  'mma-plan',
  'mma-retry',
  'mma-review',
  'mma-investigate',
  'mma-research',
  'mma-spec',
];
```

Update the explicit `supported` fixture in `tests/install/skill-manifest-sync.test.ts` to:

```ts
const supported = [
  'multi-model-agent', 'mma-delegate', 'mma-audit', 'mma-review',
  'mma-debug', 'mma-execute-plan', 'mma-retry',
  'mma-context-blocks', 'mma-investigate', 'mma-research', 'mma-explore',
  'mma-journal-record', 'mma-journal-recall', 'mma-orchestrate',
  'mma-spec', 'mma-plan', 'mma-design', 'mma-flow',
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/contract/skills/mma-flow-packaged-assets.test.ts tests/contract/skills/skill-frontmatter.test.ts tests/install/skill-manifest-sync.test.ts`
Expected: PASS

### Task I-6: Advertise `mma-flow` In The Router Skill Map And Guidance (AC-3.2)

**Files:**
- Modify: `packages/server/src/skills/multi-model-agent/SKILL.md`
- Test: `tests/skills/multi-model-agent-router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/skills/multi-model-agent-router.test.ts` with this complete content:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const raw = readFileSync('packages/server/src/skills/multi-model-agent/SKILL.md', 'utf8');

describe('multi-model-agent router skill', () => {
  it('mentions mma-flow in the skill map table', () => {
    expect(raw).toContain('| `mma-flow` |');
  });

  it('teaches mma-flow as the packaged end-to-end SDLC route', () => {
    expect(raw).toContain('mma-flow');
    expect(raw).toContain('full SDLC');
    expect(raw).toContain('design through PR creation');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/skills/multi-model-agent-router.test.ts`
Expected: FAIL because `packages/server/src/skills/multi-model-agent/SKILL.md` does not mention `mma-flow`.

- [ ] **Step 3: Write minimal implementation**

Apply this exact patch to `packages/server/src/skills/multi-model-agent/SKILL.md`:

```diff
@@
     "mma-design" [shape=box];
+    "mma-flow" [shape=box];
     "mma-spec" [shape=box];
     "mma-plan" [shape=box];
@@
     "Spec on disk?" -> "mma-plan" [label="yes — need plan"];
+    "Plan on disk?" -> "mma-flow" [label="no — need full SDLC playbook after design/spec"];
@@
 | `mma-design` | Interactive design workflow — brain dump → investigate → structured interview → write spec |
+| `mma-flow` | Packaged end-to-end SDLC playbook — locate → design/spec → audits → branch → execute → review → verify → PR → merge |
 | `mma-spec` | Write a formal spec from structured design decisions (dispatches to `spec` task type) |
 | `mma-plan` | Write a TDD implementation plan from a spec file (dispatches to `plan` task type) |
@@
 - **Plan writing** — turning a spec into ordered, testable steps with the right decomposition.
 - **Architecture and design decisions** — choosing the shape of the solution.
 - **Final approval / merge decisions** — what ships.
 - **Dialogue with the engineer** — clarifying intent, negotiating tradeoffs, answering "should we?".
+
+When the user wants the packaged full SDLC route rather than one isolated worker step, direct them to `mma-flow`. It is the packaged path from design through PR creation and conditional merge, while the other `mma-*` skills remain the underlying primitives used inside that flow.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/skills/multi-model-agent-router.test.ts`
Expected: PASS

> **Track 3 verification subset (run after I-5 → I-6 land, before moving to Release-Gate):**
> `pnpm vitest run tests/contract/skills/mma-flow-packaged-assets.test.ts tests/contract/skills/skill-frontmatter.test.ts tests/install/skill-manifest-sync.test.ts tests/skills/multi-model-agent-router.test.ts`
> Expected: PASS. Incremental checkpoint only; the Full-suite gate still runs the whole suite.

# Release-Gate (workstream 3)

- [ ] Run the contract and unit evidence from the implementation tracks and capture the green output.
- [ ] In a disposable git repository with `gh` authenticated, perform one live `mma-flow` smoke run proving spec generation, plan generation, `mma/<slug>` branch creation, execution, review, whole-repo-green verification, PR creation, and conditional merge behavior.
- [ ] Record whether the Deferred-Decision Ledger was empty or required a human gate during the smoke run.

### Full-suite gate (run after every Implementation task lands)

- [ ] Run: `pnpm vitest run` — Expected: PASS (all new + existing tests)
- [ ] Run: `pnpm build` — Expected: PASS with no type or build errors
- [ ] Run: `pnpm lint` — Expected: PASS with no lint errors
- [ ] Confirm each task was committed as its own focused commit (per commit convention)

### Spec-coverage traceability

| Spec requirement | Covered by |
|---|---|
| AC-1.1 | Task I-1 |
| AC-1.2 | Task I-1 |
| AC-1.3 | Task I-1, Task I-2 |
| AC-1.4 | Task I-1 |
| AC-1.5 | Task I-1 |
| AC-1.6 | Task I-2 |
| AC-1.7 | Task I-2 |
| AC-1.8 | Task I-1 |
| AC-1.9 | Task I-1 |
| AC-1.10 | Task I-1, Task I-2 |
| AC-2.1 | Task I-3, Task I-4 |
| AC-2.2 | Task I-4 |
| AC-2.3 | Task I-4 |
| AC-3.1 | Task I-5 |
| AC-3.2 | Task I-6 |
| AC-4.1 | Task I-5 |
| AC-4.2 | Task I-1, Task I-2 |
| AC-4.3 | Release-Gate live smoke checklist |
