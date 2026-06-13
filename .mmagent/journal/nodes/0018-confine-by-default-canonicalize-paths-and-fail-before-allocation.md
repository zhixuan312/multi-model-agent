---
id: "0018"
title: "Confine by default, canonicalize paths, and fail before allocation"
category: "design"
status: "adopted"
tags:
  - security
  - sandbox
  - cwd-only
  - path-traversal
  - realpath
  - resource-limits
  - symlinks
  - loopback
  - dns-rebinding
date: "2026-05-24"
links:
  - type: "relates"
    target: "0015"
  - type: "relates"
    target: "0017"
supersededBy: null
---

## Context
From v0.1.0, the tool sandbox treated the task `cwd` as the default trust boundary rather than an optional hardening layer. Under the default `cwd-only` policy, `readFile`, `writeFile`, `grep`, `glob`, and `listFiles` are confined to the task working directory, while traversal attempts and symlinks that resolve outside that boundary are rejected after `fs.realpath` canonicalization. The important implementation detail is that trust is based on the resolved filesystem target, not on string prefix checks over the user-supplied path, because symlinks defeat prefix-based validation.

The same boundary decision also applied to execution and resource use. `runShell` was not available inside `cwd-only`; callers had to opt into `sandboxPolicy: none` explicitly before arbitrary shell execution was enabled. File-size caps were enforced before allocating buffers or touching disk: reads above 50 MiB and writes above 100 MiB fail up front so an untrusted task cannot turn oversized file operations into host OOM or disk-fill events. Later hardening extended the network side with loopback-only binding and a Host-header guard that rejects DNS-rebinding attempts with `403`.

The durable lesson is that a delegation tool is executing untrusted-ish model output against a real host filesystem and network surface. The safe default is therefore confinement first, canonicalization before trust, and resource checks before resource commitment.

## Consequences
Sandboxed tool routes should default to the narrowest useful authority, with the task `cwd` as the baseline filesystem boundary and stronger access requiring explicit opt-in.

Path authorization must be based on canonical resolved targets such as `fs.realpath`, not on raw input strings or prefix comparisons. If a resolved path escapes the allowed root, reject it even when the original spelling appears local.

Operations with meaningful memory, disk, or socket cost should validate caps before allocating memory, opening write paths, or otherwise committing host resources. Rejecting oversize work after allocation is too late for a safety boundary.

Execution and network escape hatches should be explicit and separately guarded. Shell execution belongs behind an opt-in policy, and local network listeners should defend both the bind address and the `Host` header so loopback-only intent cannot be bypassed by rebinding tricks.
