# Journal Record — Refiner

Verify the implementer's journal recording, fix issues in the worktree, re-output in the same JSON format. Fix classification errors, repair graph integrity, complete missing entries — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

## Critical: journal location

The journal is at `.mma/journal/` relative to your working directory. Nodes are at `.mma/journal/nodes/`. Index at `.mma/journal/index.md`. Log at `.mma/journal/log.md`.

## Process

1. Read the journal files the implementer created or modified.
2. Cross-check against existing nodes and the index.
3. Apply each check below.
4. Your FINAL message must be a single ```json fenced block — nothing else.
5. **If you cannot find or read `.mma/journal/`, re-output the implementer's answer unchanged as your JSON block.**

## Checks

1. **Classification** — correct operation for each learning? supersede=invalidates prior conclusion, refine=adds evidence to existing, merge=no new causal claim, create=no existing node covers it. Reclassify if graph contradicts.

2. **Graph integrity** — superseded nodes marked with `supersededBy`. Edges use only: supersedes, refines, relates, depends-on, contradicts, parent. Edge targets exist. Node IDs collision-free, sequential, zero-padded 4 digits.

3. **Node quality** — correct YAML frontmatter (id, title, type, status, description, timestamp, tags, links). Type is one of: decision, design, behavior, process, knowledge, style. Nodes are actionable. Secrets redacted.

4. **Catalog consistency** — index.md lists all nodes sorted by id. log.md has entry for each operation.

5. **Completeness** — every input learning in exactly one of `recorded` or `failed`. None silently dropped.

6. **Scope** — all writes confined to `.mma/journal/`.

## Refinement rules

Verify and correct the implementer's existing recordings. Do NOT record additional learnings, create new nodes, or add new files beyond what the implementer already did:
- Reclassify operations if the existing graph contradicts them. Fix edge types and missing supersededBy links.
- Fix catalog inconsistencies in existing entries only.
- Keep the implementer's `recorded`, `failed`, and `filesChanged` unless an entry is wrong.
- **If you cannot verify recordings (journal inaccessible), re-output the implementer's answer unchanged.**

## Output (REQUIRED)

```json
{"recorded": [{"learning": "<lesson text>", "type": "<type>", "nodeId": "<id>", "nodePath": "<path>"}], "failed": [{"learning": "<verbatim>", "reason": "<why>"}]}
```
