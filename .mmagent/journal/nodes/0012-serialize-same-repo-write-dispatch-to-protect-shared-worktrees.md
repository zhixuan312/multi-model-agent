---
id: "0012"
title: "Serialize same-repo write dispatch to protect shared worktrees"
status: "adopted"
tags:
  - concurrency
  - dispatch
  - same-repo
  - serialization
  - data-loss
  - git
  - write-routes
date: "2026-05-24"
links:
  - type: "relates"
    target: "0002"
  - type: "relates"
    target: "0008"
  - type: "relates"
    target: "0011"
supersededBy: null
---

## Context
In v4.6.0, write-route dispatch adopted a conservative concurrency rule for shared repositories: tasks that target the same git repository are no longer run in parallel. They are grouped by repository with `groupTasksByRepo`, then dispatched serially in the caller's original input order. Only tasks that land in different repositories are allowed to run concurrently.

The change was driven by a concrete silent-data-loss class in a shared working tree. Two parallel tasks against the same repo could race on file edits, leaving one worker to overwrite or unknowingly absorb another worker's mid-flight changes. A related failure mode appeared at commit time: one task's commit could accidentally sweep in unrelated edits produced by a different task that was still running in the same checkout.

The adopted mechanism includes a repo-hygiene handoff between serial tasks. When an earlier same-repo task finishes with uncommitted edits still present, the next serial task receives an advisory prepended to its prompt so it knows it is entering a dirty working tree and must account for those edits explicitly.

The durable lesson is that concurrency safety inside one shared checkout is harder than the throughput is worth. The project's current stance is therefore to give up parallelism by default whenever write tasks touch the same repository, and only preserve parallel dispatch across repository boundaries.

## Consequences
Write-route schedulers must treat the git repository as the concurrency boundary. If two dispatched tasks share a repo, they must be serialized in caller input order rather than run in parallel.

Any future attempt to restore same-repo parallelism needs a stronger isolation mechanism than prompt discipline, such as separate worktrees or another filesystem-level boundary. Without isolation, shared-working-tree concurrency should be assumed unsafe.

When serial same-repo execution hands off a dirty repository, that fact must be surfaced to the next task explicitly. Silent reuse of a repo with uncommitted edits is part of the failure class this rule is meant to prevent.

If operators observe unexpected cross-task diffs, commits that include unrelated files, or lost edits during dispatch, inspect first whether repository grouping or same-repo serialization was bypassed.
