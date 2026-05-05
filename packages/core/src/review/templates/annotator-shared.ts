// Data shared by all 5 annotator templates. The actual prompt assembly
// happens in review/annotator-prompt-builder.ts.

export interface AnnotatorPromptContext {
  workerOutput: string;
  brief: string;
}

export interface AnnotatorTemplate {
  role: string;
  onBriefCheck: string;
}

export const ANNOTATOR_RUBRIC = String.raw`
## Output format (REQUIRED)

Respond with exactly one fenced JSON code block AS THE LAST BLOCK in your
response. The block contains a JSON array of finding objects, in the order
the worker presented them. Example:

` + '```json\n' + `[
  {
    "id": "F1",
    "severity": "critical",
    "claim": "Remote code execution via unsanitized input in src/handler.ts:42",
    "evidence": "user input is passed directly into shellExec() without escaping",
    "suggestion": "Use a parameterized API or escape input",
    "annotatorConfidence": 90
  },
  {
    "id": "F2",
    "severity": "medium",
    "claim": "Auth check missing on /admin endpoint",
    "evidence": "router.get('/admin', adminHandler) — no auth middleware applied",
    "annotatorConfidence": 60
  }
]
` + '```' + `

Field rules:
- ` + '`id`' + `: assign sequentially F1, F2, F3, ... (your choice; must be unique).
- ` + '`severity`' + `: one of "critical" | "high" | "medium" | "low" — YOUR
   final judgment, not the worker's. The worker's value is a hint; you may
   dial it up or down based on actual impact (workers tend to inflate).
   - critical: must fix before any other work (RCE, auth bypass, data loss)
   - high:     serious bug / security issue, blocks release
   - medium:   real issue, should fix soon
   - low:      minor issue, nice to fix
   Map worker-said "mid" -> "medium". When the worker omitted severity, judge.
- ` + '`claim`' + `: one-sentence summary.
- ` + '`evidence`' + `: REQUIRED, ≥20 chars, MUST be a verbatim quote from the
   worker's output. The parser flags non-substring quotes — quote precisely.
- ` + '`suggestion`' + `: optional; quote or paraphrase the worker's recommended fix.
- ` + '`annotatorConfidence`' + `: integer 0-100. How confident YOU (reviewer) are
   that the finding is correct, on-brief, and well-grounded:
     80-100: defend without hesitation
     60-79:  plausible, minor gaps
     40-59:  thin evidence
     20-39:  weak / off-brief
      0-19:  unsupported / fabricated

If the worker raised NO issues, return ` + '`[]`' + `. Surrounding prose is allowed
but ignored by the parser — only the LAST ` + '```json' + ` block is read.
`.trim();
