# Journal schema (conventions — do not override the rules below)

## Node id
Zero-padded 4-digit string, allocated as max(existing) + 1.

## Filename
`nodes/<id>-<kebab-case-title>.md`.

## Category (fixed enum)
decision | design | behavior | process | knowledge | style

- **decision**: Technical trade-off outcomes — tried X, dropped it, use Y instead.
- **design**: Architecture/pattern rationale — why things are built this way.
- **behavior**: User interaction patterns, workflow preferences, communication style.
- **process**: SDLC/workflow learnings — what works, what doesn't, how phases operate.
- **knowledge**: Factual findings from research/exploration — domain facts, API capabilities, ecosystem state.
- **style**: Documentation conventions, code patterns, naming rules, writing norms.

## Status (fixed enum)
adopted | dropped | inconclusive | superseded

## Edge types (fixed set)
supersedes | refines | relates | depends-on | contradicts | parent

## Tags
Free-form lowercase kebab-case.

## index.md
Markdown table: id | date | category | status | title | tags — one row per node, sorted by id ascending.

## log.md
Append-only, one line per write: <ISO-8601 date>  <op>  <id>  <title>  (op ∈ create|refine|supersede|merge).

This file's prose/tag guidance is human-editable; the status enum, edge-type set,
and id/filename rules are fixed by code and may not be overridden here.
