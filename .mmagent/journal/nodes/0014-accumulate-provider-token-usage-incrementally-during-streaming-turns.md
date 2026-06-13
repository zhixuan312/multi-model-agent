---
id: "0014"
title: "Accumulate provider token usage incrementally during streaming turns"
category: "design"
status: "adopted"
tags:
  - providers
  - token-usage
  - telemetry
  - streaming
  - partial-runs
  - claude
  - openai-compatible
date: "2026-05-24"
links:
  - type: "refines"
    target: "0004"
  - type: "relates"
    target: "0005"
supersededBy: null
---

## Context
Provider token usage cannot be recovered reliably by reading only the terminal message for a turn. Both Claude's SDK and OpenAI-compatible providers produced billable assistant activity before the terminal `result`, but timeout, abort, and mid-stream error paths often ended without a usable final usage payload. The observed failure mode was telemetry that reported real work volume, such as `turnCount: 21` and `toolCallCount: 12`, while collapsing billing fields to `costUSD: 0`, `inputTokens: 0`, and `outputTokens: 0`.

The corrective rule is to accumulate usage from the earliest trustworthy provider signal, not from the terminal summary alone. For Claude, merge `msg.message.usage` from every SDK message whose type is `assistant` into a running accumulator during the stream, then let the terminal `result` replace the accumulator only when it carries the provider's cumulative total so the same tokens are not counted twice. For OpenAI-compatible providers such as DeepSeek, retain the last non-null HTTP-level usage snapshot for each request because later streaming chunks can overwrite the consumer-visible usage field with `undefined` before completion.

The durable lesson is that usage capture belongs at the incremental provider boundary. If billing truth is deferred until the final terminal message, the exact runs that need observability most, such as partial, aborted, or errored executions, lose their token accounting entirely.

## Consequences
Telemetry should price turns from incrementally accumulated provider usage so partial and aborted runs still report truthful token and cost totals.

Provider adapters must treat terminal usage as one possible reconciliation point, not the only source of truth. If a terminal payload is cumulative, it should replace earlier partial totals; if it is absent, the running accumulator remains the best available fact.

During review, treat any terminal-only usage capture path as a data-loss bug. Streaming providers routinely surface usable token information before completion, and discarding that signal creates fake zero-cost telemetry precisely on failed or interrupted runs.
