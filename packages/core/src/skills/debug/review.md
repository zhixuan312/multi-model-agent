# Debug — Refiner

Verify the implementer's debug investigation, improve quality, re-output the answer in the same JSON format. Remove errors, add missing trace steps, fix cause/symptom confusion — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

**Your entire response must be a single ```json fenced block. No text before or after it. No verification narrative, no reasoning, no tool-call commentary.**

## Checks

1. **Trace completeness** — chain from SYMPTOM → INTERMEDIATE → CAUSE with file:line at each step. At least 3 points. Partial-evidence with explicit gap-marking is valid.

2. **Cause vs symptom** — the cause must be UPSTREAM of the symptom. If "cause" is the throwing/failing line, that's the symptom — fix the cause identification.

3. **Reproduction** — specific enough to trigger the failure (exact command, input, state)? Not vague ("run the tests")?

4. **Falsifier** — concrete way to verify the fix. Names a specific assertion, output, or observable behavior. Add one if missing.

5. **Evidence quality** — file:line citations from files read this session, not hallucinated. Remove fabricated citations.

6. **Fix feasibility** — proposed fix addresses the CAUSE, not the symptom. Fix is read-only (proposed, NOT applied). Remove applied changes.

7. **Pre-existing separation** — entangled bugs in `otherDefects`, not mixed into the main trace.

## Refinement rules

- Fix cause/symptom misidentification. Add missing trace steps.
- Add missing falsifiers. Separate pre-existing bugs into `otherDefects`.
- Only correct `proposedFix` if it targets the wrong file:line or the wrong defect. Do NOT expand, elaborate, or rewrite a correct fix — a shorter correct fix is better than a longer rewritten one.
- Only correct `falsifier` if it tests the wrong thing. Do NOT rewrite a correct falsifier.

## Output (REQUIRED)

```json
{"reproduction": "<steps>", "symptom": {"file": "<path>", "line": 0, "description": "<what fails>"}, "cause": {"file": "<path>", "line": 0, "description": "<defect>"}, "trace": [{"file": "<path>", "line": 0, "observation": "<what happens>"}], "proposedFix": "<change at cause>", "falsifier": "<verification>", "otherDefects": ["<out of scope>"]}
```
