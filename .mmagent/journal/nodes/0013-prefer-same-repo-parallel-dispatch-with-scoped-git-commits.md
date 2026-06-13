---
id: "0013"
title: "Prefer same-repo parallel dispatch with scoped git commits"
category: "decision"
status: "adopted"
tags:
  - concurrency
  - dispatch
  - parallel
  - commit-mutex
  - git-attribution
  - pathspec
  - same-repo
  - git
date: "2026-05-24"
links:
  - type: "supersedes"
    target: "0012"
  - type: "relates"
    target: "0008"
  - type: "relates"
    target: "0011"
supersededBy: null
---

## Context
The v4.6.0 response to same-repo write hazards was to group tasks by repository and serialize them. That protected the shared checkout, but it also threw away useful throughput by treating the whole repository as the unit of exclusion.

In v4.7.14, the project identified the narrower failure boundary: the unsafe part was not parallel dispatch itself, but incorrect commit attribution inside a shared checkout. Same-repo workers became safe to run in parallel once each worker committed only its own harness-tracked written files with pathspec-scoped `git add -- <files>` and `git commit -- <files>`, never `git add -A`, and once the changed-file set came from a git-truth diff instead of the worker's self-report.

The remaining shared-repo race is the git index during stage-and-commit. The adopted safeguard is a process-global per-repo commit mutex keyed by the repository toplevel, which serializes only the stage-plus-commit section for that repo. Distinct repositories still commit fully in parallel, and same-repo workers still execute their substantive work in parallel; they only queue briefly for the guarded git operation that would otherwise contend on `.git/index.lock` or accidentally sweep in another worker's edits.

The durable lesson is to fix the dangerous operation precisely rather than sacrificing concurrency at the scheduler level. Once per-worker commit scoping and commit-time mutual exclusion are correct, dispatch concurrency can return to being a simple caller choice of `parallel` or `serial`, and the older same-repo grouping machinery is no longer the right safety mechanism.

## Consequences
Write-route dispatch should allow concurrent same-repo tasks by default whenever the caller selects parallel execution. Repository identity is no longer a reason to downgrade a dispatch from parallel to serial on its own.

Workers that write in a shared repository must commit only harness-tracked files derived from git diff truth. Any flow that relies on worker self-reporting, broad staging such as `git add -A`, or unscoped commit inputs reintroduces the cross-task attribution bug this rule replaces.

The only repo-local serialization point should be the guarded stage-and-commit section, protected by a process-global mutex keyed by git toplevel. If same-repo workers collide on `.git/index.lock` or sweep each other's edits into one commit, inspect the mutex boundary and pathspec scoping before considering scheduler-level serialization.

Dispatch code should expose concurrency as an explicit per-dispatch choice such as `parallel` or `serial` and retire same-repo grouping logic that exists only to force serialization for safety.
