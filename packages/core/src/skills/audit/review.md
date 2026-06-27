# Audit — Refiner

Verify the implementer's audit against the original document, improve quality, re-output in the same JSON format. Remove errors, add missed findings, fix calibration — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

## Process

1. Read the document referenced in the Original Task section (file path or inline content).
2. For plan audits, also read codebase files referenced in source-side evidence.
3. Apply each check below against both the document and the implementer's findings.
4. Your FINAL message must be a single ```json fenced block — nothing else.

## Checks

1. **Evidence shape** — each finding uses the correct evidence shape for its subtype:
   - Default: doc quote, absence reference, wrong-claim, or internal-coherence.
   - Plan (1-8): plan-side + source-side (file:line + content). Missing source-side = drop.
   - Plan (10): spec clause + plan task. Plan (9,11,12): plan-side quote sufficient.
   - Spec: exact `shall`/`must`/`should` clause. Skill: heading + offending line.
   - Remove or downgrade findings with wrong evidence shape.

2. **Hallucination** — search the document for each quoted passage. Remove findings whose evidence is fabricated or misquoted.

3. **Severity calibration** — verify against subtype rules. Default: critical=incoherence blocks execution, low=stylistic. Plan: critical=contradicts codebase, low=cosmetic. Spec: critical=ships wrong behavior silently, low=no behavior change. Skill: critical=wrong-tool routing, low=stylistic.

4. **Coverage** — all criteria evaluated? Default=11, Plan=12, Spec=9, Skill=7. Add "no findings" for skipped criteria.

5. **Missed issues** — read the document yourself. Look for contradictions, ambiguous load-bearing terms, placeholder language, missing verification steps the implementer missed. Add if found.

6. **Plan audits: USE vs DEFINE** — remove false-positive DEFINE-intent flags. Add missed USE-intent symbols.

## Refinement rules

- Remove hallucinated/wrong-evidence findings. Add missed issues. Correct severities.
- Update `criteriaCovered` and `findings` to match corrected state.
- Verify every evidence string starts with a `[### Heading]` section prefix. If missing, add the correct heading from the audited document. If the heading is wrong, fix it to match the actual document heading.
- Improve finding wording if you can add clarity. Don't rephrase correct findings for style.

## Output (REQUIRED)

```json
{"criteriaCovered": ["<slug>"], "findings": [{"weight": "critical|high|medium|low", "category": "<slug>", "claim": "<one sentence>", "evidence": "<quoted text>", "suggestion": "<fix>"}]}
```
