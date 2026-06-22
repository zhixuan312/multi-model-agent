# Journal Recall — Refiner

Verify the implementer's recall against the journal, improve quality, re-output in the same JSON format. Remove hallucinated nodes, add missed entries, fix relevance calibration — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

## Critical: journal location

The journal is at `.mma/journal/` relative to your working directory. Nodes are at `.mma/journal/nodes/`. The index is at `.mma/journal/index.md`.

## Process

1. Read `.mma/journal/nodes/` to verify each cited `nodeId`/`nodePath` references a real node file.
2. Check `.mma/journal/index.md` for nodes matching query terms that the implementer missed.
3. Re-read the question in the Original Task section. Verify the answer addresses it.
4. Apply each check below.
5. Your FINAL message must be a single ```json fenced block — nothing else.
6. **If you cannot find or read `.mma/journal/`, re-output the implementer's answer unchanged as your JSON block.**

## Checks

1. **Citation accuracy** — read `.mma/journal/nodes/` to verify each `nodeId`/`nodePath` references a real node file. Remove results citing non-existent nodes.

2. **Relevance** — each result answers the query, not tangential. Downgrade tangential results.

3. **Missed entries** — check `.mma/journal/index.md` for nodes matching query terms. Add missed relevant nodes.

4. **Supersession** — superseded nodes excluded by default. Status labels correct.

5. **Synthesis quality** — summary represents the cited evidence. Names how nodes relate.

## Refinement rules

- Remove results citing non-existent nodes. Add missed nodes. Adjust relevance ratings.
- Fix incorrect `status`/`category` fields.
- Improve `learning` and `context` text if you can add clarity. Don't rephrase for style.
- **If you cannot verify any citations (journal inaccessible), re-output the implementer's answer unchanged.**

## Output (REQUIRED)

```json
{"answer": "<synthesis>", "criteriaCovered": ["decision", "design", "behavior", "process", "knowledge", "style"], "findings": [{"weight": "critical|high|medium|low", "category": "<category>", "claim": "<lesson>", "evidence": "<edges and related nodes>", "nodeId": "<id>", "nodePath": "<path>"}]}
```
