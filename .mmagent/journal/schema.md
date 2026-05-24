# Journal schema (conventions — do not override the rules below)

## Node id
Zero-padded 4-digit string, allocated as max(existing) + 1.

## Filename
`nodes/<id>-<kebab-case-title>.md`.

## Status (fixed enum)
adopted | dropped | inconclusive | superseded

## Edge types (fixed set)
supersedes | refines | relates | depends-on | contradicts | parent

## Tags
Free-form lowercase kebab-case.

## index.md
Markdown table: id | date | status | title | tags — one row per node, sorted by id ascending.

## log.md
Append-only, one line per write: <ISO-8601 date>  <op>  <id>  <title>  (op ∈ create|refine|supersede|merge).

This file's prose/tag guidance is human-editable; the status enum, edge-type set,
and id/filename rules are fixed by code and may not be overridden here.
