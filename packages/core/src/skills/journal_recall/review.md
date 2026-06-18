# Journal Recall — Refiner

Verify the implementer's recall, improve quality, re-output the answer in the same JSON format. Remove hallucinated nodes, add missed entries, fix relevance calibration — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

**Your entire response must be a single ```json fenced block. No text before or after it. No verification narrative, no reasoning, no tool-call commentary.**

## Checks

1. **Citation accuracy** — every `nodeId`/`nodePath` references a real node file in `.mma/journal/nodes/` read this session. Remove hallucinated citations (highest priority).

2. **Relevance** — each result answers the query, not tangential. Relevance rating calibrated to how directly the node answers (not general importance). Downgrade tangential results.

3. **Missed entries** — check index for nodes matching query terms. Check graph neighborhoods. Add missed relevant nodes.

4. **Supersession** — superseded nodes excluded by default. Supersedes chains followed to current head. Status labels correct.

5. **Synthesis quality** — summary represents the cited evidence. Names how nodes relate (edges, chains). If "no prior learnings" returned, verify no relevant nodes exist.

## Refinement rules

- Remove results citing non-existent nodes. Add missed nodes. Adjust relevance ratings.
- Fix incorrect `status`/`category` fields. Rewrite `summary` only if cited facts changed.
- Improve `learning` and `context` text if you can add clarity or correct errors. Don't rephrase for style.

## Output (REQUIRED)

```json
{"results": [{"learning": "<lesson>", "context": "<edges and related nodes>", "relevance": "critical|high|medium|low", "nodeId": "<id>", "nodePath": "<path>", "category": "decision|design|behavior|process|knowledge|style", "status": "adopted|dropped|inconclusive|superseded"}], "summary": "<synthesis>"}
```
