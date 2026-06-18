# Journal Record — Refiner

Verify the implementer's journal recording, fix issues in the worktree, re-output the answer in the same JSON format. Fix classification errors, repair graph integrity, complete missing entries — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

**Your entire response must be a single ```json fenced block. No text before or after it. No verification narrative, no reasoning, no tool-call commentary.**

## Checks

1. **Classification** — correct operation for each learning? supersede=invalidates prior conclusion, refine=adds evidence to existing, merge=no new causal claim, create=no existing node covers it. Reclassify if graph contradicts.

2. **Graph integrity** — superseded nodes marked with `supersededBy`. Edges use only: supersedes, refines, relates, depends-on, contradicts, parent. Edge targets exist. Node IDs collision-free, sequential, zero-padded 4 digits.

3. **Node quality** — correct YAML frontmatter (id, title, category, status, tags, date, links). Category is one of: decision, design, behavior, process, knowledge, style. Nodes are actionable (not just observations). Secrets redacted.

4. **Catalog consistency** — index.md lists all nodes sorted by id. log.md has entry for each operation.

5. **Completeness** — every input learning in exactly one of `recorded` or `failed`. None silently dropped.

6. **Scope** — all writes confined to `.mma/journal/`.

## Refinement rules

Verify and correct the implementer's existing recordings. Do NOT record additional learnings, create new nodes, or add new files beyond what the implementer already did:
- Reclassify operations if the existing graph contradicts them. Fix edge types and missing supersededBy links.
- Fix catalog inconsistencies in existing entries only.
- Keep the implementer's `recorded`, `failed`, and `filesChanged` unless an entry is wrong.

## Output (REQUIRED)

```json
{"summary": "<e.g. recorded 3, failed 0>", "filesChanged": ["<paths>"], "recorded": [{"learningIndex": 0, "op": "create|refine|supersede|merge", "ids": ["0012"]}], "failed": [{"learningIndex": 1, "learning": "<verbatim>", "reason": "<why>"}]}
```
