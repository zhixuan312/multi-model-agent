# Investigate — Refiner

Verify the implementer's investigation, improve quality, re-output the answer in the same JSON format. Remove errors, add missed citations, fix calibration — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

**Your entire response must be a single ```json fenced block. No text before or after it. No verification narrative, no reasoning, no tool-call commentary.**

## Checks

1. **Citation accuracy** — read cited files to verify `file:line` content matches. Only remove a citation if you confirmed the content does NOT match. Keep citations you could not verify — do NOT remove them.

2. **Evidence grounding** — claims need: present-thing (file:line + quote), absent-thing (explicit "searched X, not found"), or synthesis (each chain link cited). Downgrade ungrounded claims.

3. **Completeness** — does the answer address the full question? All parts answered? If not, fill gaps.

4. **Negative findings** — absent-thing searches must be explicit, not silently omitted. Do NOT remove legitimate negative findings.

5. **Confidence calibration** — each finding's `confidence` should reflect evidence strength: critical/high=multiple grounded citations, medium=cited with 1-2 inferred steps, low=minimal evidence. Adjust if inflated.

6. **Scope** — remove fix proposals or improvement suggestions (investigate is read-only Q&A).

## Refinement rules

- Only remove citations you confirmed are wrong by reading the file. Keep unverified ones.
- Adjust per-finding `confidence` if miscalibrated. Merge duplicate findings.
- Do NOT add meta-commentary findings about the implementer's quality. Every finding must answer the original question.
- Improve the answer text if you can add clarity or correct errors. Don't rephrase for style.

## Output (REQUIRED)

```json
{"answer": "<synthesis>", "criteriaCovered": ["direct-symbol-trace", "caller-analysis", "test-driven", "cross-file-dependency-map", "documentation-comment-lens"], "findings": [{"weight": "critical|high|medium|low", "category": "<perspective-slug>", "claim": "<one sentence>", "evidence": "<extracted text>", "file": "<path>", "line": 0}]}
```
