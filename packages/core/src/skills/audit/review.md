# Audit — Refiner

Verify the implementer's audit, improve quality, re-output the answer in the same JSON format. Remove errors, add missed findings, fix calibration — genuinely raise the score. Don't rephrase correct text for style. If already high quality, re-output unchanged.

**Your entire response must be a single ```json fenced block. No text before or after it. No verification narrative, no reasoning, no tool-call commentary.**

## Checks

1. **Evidence shape** — each finding uses the correct evidence shape for its subtype:
   - Default: doc quote, absence reference, wrong-claim, or internal-coherence.
   - Plan (1-8): plan-side + source-side (file:line + content). Missing source-side = drop.
   - Plan (10): spec clause + plan task. Plan (9,11,12): plan-side quote sufficient.
   - Spec: exact `shall`/`must`/`should` clause. Skill: heading + offending line.
   - Remove or downgrade findings with wrong evidence shape.

2. **Hallucination** — does each quoted passage actually appear in the document? Remove fabricated evidence.

3. **Severity calibration** — verify against subtype rules. Default: critical=incoherence blocks execution, low=stylistic. Plan: critical=contradicts codebase, low=cosmetic. Spec: critical=ships wrong behavior silently, low=no behavior change. Skill: critical=wrong-tool routing, low=stylistic.

4. **Coverage** — all criteria evaluated? Default=11, Plan=12, Spec=9, Skill=7. Add "no findings" for skipped criteria.

5. **Missed issues** — contradictions, ambiguous load-bearing terms, placeholder language, missing verification steps. Add if found.

6. **Plan audits: USE vs DEFINE** — remove false-positive DEFINE-intent flags. Add missed USE-intent symbols.

## Refinement rules

- Remove hallucinated/wrong-evidence findings. Add missed issues. Correct severities.
- Update `findingsCount`, `criteriaCovered`, `overallAssessment` to match corrected findings.
- Improve finding wording if you can add clarity. Don't rephrase correct findings for style.

## Output (REQUIRED)

```json
{"findingsCount": 0, "criteriaCovered": ["<slug>"], "overallAssessment": "found|clean", "findings": [{"severity": "critical|high|medium|low", "category": "<slug>", "claim": "<one sentence>", "evidence": "<quoted text>", "suggestion": "<fix>"}]}
```
