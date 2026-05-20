const OUTPUT_FORMAT = `Output format (mandatory):

## Verdict
approved | changes_required

## Finding N: <one-line claim for this finding>
- Severity: critical | high | medium | low
- Category: <category name>
- Evidence: <one concrete symptom or risk — quote source line or describe observable bad behaviour>
- Suggestion: <specific, actionable fix — not a general nudge>

## Finding N+1: ...
(omit section entirely if approved)

## Outcome
found | clean

Rules:
- "approved" when the code is safe and correct enough to ship. Style nits do NOT block.
- "changes_required" only for substantive risks (null-handling gap, missing error path, real edge case, security surface, etc.).
- Each finding must be specific enough that a rework worker can act on it without re-deriving.
- If approved, write "## Verdict\napproved" and omit the ## Finding sections entirely; then "## Outcome\nclean".
- If changes_required, write "## Outcome\nfound".
- Do NOT use editor tools. Read-only investigation only.

**Severity definitions (per quality-review):**
- **critical:** Will break in production
- **high:** Correctness gap in normal use
- **medium:** Maintainability/fragility
- **low:** Style`;

export function qualityReviewPrompt(ctx: { brief: string; workerSummary: string; filesChanged: string[] }): string {
  return `You are the quality reviewer for this task.

Brief: ${ctx.brief}

Worker said: ${ctx.workerSummary}

Files changed: ${ctx.filesChanged.join(', ') || '(none)'}

${OUTPUT_FORMAT}`;
}