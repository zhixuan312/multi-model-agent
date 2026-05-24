// Dedicated cross-agent review for the journal-record write route. Its
// "diff" is markdown ADR nodes under .mmagent/journal/, NOT source code, so
// the generic spec/quality code-review prompts mis-fit (they can produce a
// degenerate `changes_required` with no findings). This validates the NODE on
// its own terms. Output format is identical to the quality reviewer so
// parse-review-report.ts parses it unchanged.

const OUTPUT_FORMAT = `Output format (mandatory):

## Verdict
approved | changes_required

## Finding N: <one-line claim for this finding>
- Severity: critical | high | medium | low
- Category: frontmatter | edges | schema | confinement | dedup | content
- Evidence: <quote the offending frontmatter / line>
- Suggestion: <specific, actionable fix>

## Outcome
found | clean

Rules:
- "approved" when the node is well-formed and faithfully records the learning. Minor wording is NOT a blocker.
- "changes_required" ONLY for real schema/correctness problems below — and when you do, you MUST enumerate at least one ## Finding. Never return changes_required with no findings.
- If approved: write "## Verdict\\napproved", omit the ## Finding sections, then "## Outcome\\nclean".
- Read-only investigation; do NOT use editor tools.`;

export function journalReviewPrompt(ctx: { brief: string; workerSummary: string; filesChanged: string[]; diff?: string }): string {
  const diffContent = ctx.diff && ctx.diff.trim() ? ctx.diff : '(no diff available)';
  return `You are the journal reviewer. You are validating a change to a project's
learnings journal — markdown ADR "node" files under \`.mmagent/journal/\`, NOT
source code. Judge the node on its own terms; do not apply code-quality criteria.

Brief: ${ctx.brief}

Worker said: ${ctx.workerSummary}

Files changed: ${ctx.filesChanged.join(', ') || '(none)'}

Diff (authoritative — what actually changed on disk):
${diffContent}

Validate the node(s):
1. FRONTMATTER well-formed: id (zero-padded 4-digit string, e.g. "0007"), title, status ∈ {adopted, dropped, inconclusive, superseded}, tags (lowercase kebab-case), date (ISO YYYY-MM-DD), links (array of {type, target}), supersededBy (an id or null).
2. EDGES use only: supersedes, refines, relates, depends-on, contradicts, parent.
3. CONTENT: the body has "## Context" and "## Consequences" sections, coherent and faithful to the learning in the brief.
4. CONFINEMENT: all changed paths are under \`.mmagent/journal/\` (nodes/, index.md, log.md, schema.md). Flag any file written outside it.
5. DEDUP integrity: on a supersede, the superseded node's status is "superseded" with supersededBy set; index.md gained the row and log.md gained exactly one line.

Guardrails:
- the diff above is ground truth — do NOT claim files are missing/untracked
- this is markdown/docs, not code — judge the node's correctness, not code style

${OUTPUT_FORMAT}`;
}
