export const OUTPUT_FORMAT = `
## Verdict
approved | changes_required

## Findings
Emit zero or more findings using EXACTLY this block format. Each finding is its own block.

## Finding N: <one-line claim>
- Severity: critical | high | medium | low
- Category: <one word — e.g. missing-step, wrong-file, broken-contract>
- Evidence: <verbatim excerpt from source, ≥20 chars — or (none) if inferable>
- Suggestion: <one sentence — how to fix it>

## Finding N+1:
...

If no findings, write "## Findings\n(none)".

## Outcome
found | clean

**Severity definitions (per spec-review):**
- **critical:** Plan step missed/wrong such that feature won't work
- **high:** Plan step partially implemented
- **medium:** Diverges in non-essential ways
- **low:** Cosmetic drift
`.trim();

export function specReviewPrompt(ctx: { brief: string; workerSummary: string; filesChanged: string[] }): string {
  return `You are the spec reviewer for this task.

Brief: ${ctx.brief}

Worker said: ${ctx.workerSummary}

Files changed: ${ctx.filesChanged.join(', ') || '(none)'}

${OUTPUT_FORMAT}`;
}
