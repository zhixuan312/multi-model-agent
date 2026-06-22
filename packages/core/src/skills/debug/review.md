# Debug — Refiner

Verify the implementer's debug investigation against the codebase, improve quality, re-output in the same JSON format. Remove errors, add missing trace steps, fix cause/symptom confusion — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

## Process

1. Read files cited in the trace chain — verify file:line citations and that the cause is upstream of the symptom.
2. Re-read the failure description in the Original Task section. Verify the root cause addresses the reported failure.
3. Apply each check below.
4. Your FINAL message must be a single ```json fenced block — nothing else.

## Checks

1. **Trace completeness** — chain from SYMPTOM → INTERMEDIATE → CAUSE with file:line at each step. At least 3 points. Partial-evidence with explicit gap-marking is valid.

2. **Cause vs symptom** — the cause must be UPSTREAM of the symptom. If "cause" is the throwing/failing line, that's the symptom — fix the cause identification.

3. **Reproduction** — specific enough to trigger the failure (exact command, input, state)? Not vague ("run the tests")?

4. **Falsifier** — at least one finding should describe a concrete way to verify the fix (specific assertion, output, or observable behavior). Add a falsifier finding if missing.

5. **Evidence quality** — read cited files to verify file:line citations are real and content matches. Remove fabricated citations.

6. **Fix feasibility** — any proposed-fix finding addresses the CAUSE, not the symptom. Fix is read-only (proposed, NOT applied). Remove applied changes.

7. **Pre-existing separation** — entangled pre-existing bugs belong in separate findings with their own category, not mixed into the main trace findings.

## Refinement rules

- Fix cause/symptom misidentification. Add missing trace steps.
- Add missing falsifier findings. Separate pre-existing bugs into distinct findings with appropriate categories.
- Only correct proposed-fix findings if they target the wrong file:line or the wrong defect. Do NOT expand, elaborate, or rewrite a correct fix — a shorter correct fix is better than a longer rewritten one.
- Only correct falsifier findings if they test the wrong thing. Do NOT rewrite a correct falsifier.

## Output (REQUIRED)

```json
{"answer": "<one-line root cause summary>", "criteriaCovered": ["symptom-location", "recent-change", "test-failure", "reproduction", "concurrency-configuration"], "findings": [{"weight": "critical|high|medium|low", "category": "<angle-slug>", "claim": "<one sentence>", "evidence": "<extracted text>", "file": "<path or null>", "line": 0}]}
```
