---
id: "0016"
title: "Track file activity only from provider-proven events"
category: "design"
status: "adopted"
tags:
  - observability
  - headline
  - honesty
  - file-tracking
  - no-heuristics
  - provider-events
date: "2026-05-24"
links:
  - type: "relates"
    target: "0005"
  - type: "relates"
    target: "0011"
  - type: "relates"
    target: "0014"
supersededBy: null
---

## Context
The polling headline used to show `reads=0 writes=0` for a task's entire lifetime even while work was happening. The direct cause was provider event handling: Claude `tool_use` blocks recorded empty file arrays, so the headline displayed a confident zero instead of admitting that file activity was unknown.

The fix was to extract file paths only from provider-structured tool events that actually name the file. `Read` events populate `filesRead`, and `Write`, `Edit`, and `MultiEdit` events populate `filesWritten`. The implementation explicitly rejected two tempting shortcuts: tool-name heuristics and shell-pattern matching. That matters most for Codex, where `run_shell` emits no file event at all, so shell-driven reads such as `cat`, `sed`, and `nl` remain intentionally untracked rather than guessed.

The adopted rule is strict: only surface file-activity counters when the provider supplied the actual file path. The adaptive headline always shows tool count, but it only shows `reads=` or `writes=` when the observed count is greater than zero. If the provider does not emit file evidence, the UI hides that dimension instead of fabricating a zero or inferring one from command text.

## Consequences
Observability code must treat missing file evidence as unknown, not as zero activity. A displayed zero is a factual claim that no reads or writes were observed; it cannot be used as a placeholder for "we do not know."

Provider integrations must map file activity from structured event payloads, not from tool names, command strings, or other secondary heuristics. If a provider does not expose the file path, file-level counters for that action stay absent.

UI headlines and progress summaries should degrade honestly. Show counters that are provable, such as total tools used, and hide file-read or file-write counters when the underlying evidence is unavailable.

During review, treat inferred file-activity telemetry as a trust regression. False positives and fake zeros erode operator trust faster than partial observability, because they look authoritative while being wrong.
