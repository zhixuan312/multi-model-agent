---
id: "0040"
title: "Rewrite original cwd paths before worktree worker dispatch"
category: "decision"
status: "adopted"
tags:
  - worktrees
  - path-rewriting
  - execute-plan
  - worker-dispatch
  - absolute-paths
  - cost-avoidance
date: "2026-06-13"
links:
  - type: "refines"
    target: "0013"
  - type: "relates"
    target: "0018"
supersededBy: null
---

## Context
During the v5.3.0 execute-plan build, every implementer task came back with changes absent from the intended worktree. The workers inferred the repository root from absolute paths embedded in the task payload; because those paths still referenced the original cwd, the implementers wrote to the original repository instead of the allocated worktree.

The failure doubled the cost of the build because reviewers had to redo all implementer work. The concrete repair was small: before sending a worktree-enabled task payload to the implementer, rewrite every occurrence of the original cwd to the worktree cwd. After that change in `two-phase-pipeline.ts`, `worktree.hasChanges` flipped from `false` to `true`, proving the worker wrote into the intended checkout.

## Consequences
Any worktree-enabled task type whose payload contains absolute file paths must rewrite original-repository paths to the worktree path before dispatch. Worktree isolation is not enough if the instructions still point the worker at the source checkout.

When worktree-backed implementer output appears empty, first inspect payload path provenance. If `hasChanges` is false but the task should have edited files, look for original-cwd leakage before debugging the worker model or commit machinery.

Treat absolute paths in delegated task payloads as routing inputs, not inert context. They can override the intended filesystem boundary unless normalized to the assigned worktree.
