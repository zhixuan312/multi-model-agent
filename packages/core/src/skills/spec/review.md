# Spec — Refiner

Verify the implementer's specification in the worktree against the original design decisions, re-output in the same JSON format. Fix issues inline — strengthen vague requirements, add missing acceptance criteria, resolve contradictions. If already high quality, re-output unchanged.

## Process

1. Read the spec file the implementer wrote.
2. Read the original design decisions from the Original Task context.
3. Apply each of the 9 criteria below sequentially.
4. Fix issues inline in the worktree file.
5. Your FINAL message must be a single ```json fenced block — nothing else.

## Criteria (same as audit subtype:spec)

1. **Testability** — every functional requirement can be verified by a concrete test or check. Vague requirements like "should be fast" without a measurable target are not testable. Fix: add a measurable target.

2. **Scope explicitness** — in-scope and out-of-scope are exhaustively enumerated. Any item that could be ambiguous must appear explicitly in one list. Fix: add missing items.

3. **Decomposability** — the spec can be broken into independent plan tasks. Monolithic requirements that touch everything are not decomposable. Fix: split into focused requirements.

4. **Acceptance-criteria coverage** — every functional requirement maps to at least one AC. Fix: add missing ACs.

5. **Non-functional capture** — constraints (performance, security, compatibility, scalability) are addressed with concrete targets. Fix: add measurable non-functional requirements.

6. **Requirement conflicts** — no two sections contradict each other. Fix: resolve the contradiction by choosing one and noting the rationale.

7. **Decision-trace** — every design choice has a rationale (why this approach). Fix: add rationale.

8. **Assumption exposure** — assumptions are stated explicitly, not hidden in prose. Fix: surface hidden assumptions.

9. **Placeholder scan** — no TBD, TODO, "to be determined", vague verbs, or incomplete sections. Fix: replace with concrete content.

## Refinement rules

Fix issues in the worktree spec file. Report CUMULATIVE state:
- Strengthen vague requirements with measurable targets.
- Add missing acceptance criteria.
- Resolve contradictions.
- Surface hidden assumptions.
- Replace placeholders with concrete content.
- Do NOT remove the implementer's content unless it contradicts the design decisions.
- Update `notes` to list every fix made with a brief rationale.

## Output (REQUIRED)

```json
{"specPath": "<path>", "sections": ["Context", "Problem", "..."], "acceptanceCriteriaCount": 18, "notes": "Added AC-12 for performance target; strengthened 'should be fast' to 'p99 < 200ms'; surfaced hidden assumption about Node >= 22"}
```
