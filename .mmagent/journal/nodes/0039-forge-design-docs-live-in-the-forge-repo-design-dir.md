---
id: "0039"
title: Forge design docs live in the Forge repo design/ dir, not docs/superpowers
status: adopted
tags: [forge, docs, process, decision, repo-boundary]
date: 2026-06-08
links:
  - type: refines
    to: "0034"
  - type: relates
    to: "0027"
  - type: parent
    to: "0026"
supersededBy: null
---

## Context

FORGE DOCS LOCATION (2026-06-08): design docs now live **in the Forge repo** at
`multi-model-agent-forge/design/{product.md, technical.md}` — **moved out of**
`mma-parent/docs/superpowers`.

Both were **rewritten 2026-06-08** to capture:

- the **two-regime freeze model** (0035),
- the **one-repo-per-task rule** (0036),
- the **single-team / shared-credential / project-visibility model** (0037), and
- the **component-role mapping** (0038).

This refines 0034 (record decisions to the journal before a formal spec): the
journal-first preference still holds for in-flight decisions, but the
consolidated product/technical design now lives as durable docs inside the Forge
repo itself, co-located with the code (relates 0027's own-repo boundary).

## Consequences

- Forge design docs are versioned with the Forge code in
  `multi-model-agent-forge/design/`, not in `mma-parent/docs/superpowers` — keep
  them out of the mma-parent tree.
- `product.md` and `technical.md` are the current canonical write-ups of the
  freeze model, one-repo rule, tenancy model, and component-role mapping; update
  them as those decisions evolve.
- Consistent with 0027 (Forge is its own repo) — design lives with its product;
  no shared docs tree with mma.
- 0034's "journal before formal spec" still governs new conclusions; this node
  just records that the formal design surface now exists and where it lives.
