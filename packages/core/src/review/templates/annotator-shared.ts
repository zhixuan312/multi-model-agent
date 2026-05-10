// Data shared by all 5 annotator templates. The actual prompt assembly
// happens in review/annotator-prompt-builder.ts.

export interface AnnotatorPromptContext {
  /** N parallel sub-worker narratives, one per criterion the dispatcher
   *  fanned out. The empty-result narrative ("No findings for this
   *  criterion.") is filtered out by the engine before this context is
   *  built — entries here are non-empty narratives that need merging. */
  workerOutputs: Array<{ criterion: string; narrative: string }>;
  brief: string;
}

export interface AnnotatorTemplate {
  role: string;
  onBriefCheck: string;
  /** Per-tool evidence rule. Tells the annotator what counts as
   *  grounded evidence for findings from this tool. */
  evidenceRule: string;
  /** Per-tool scope rule. Tells the annotator what is in/out of scope
   *  for findings from this tool. */
  scopeRule: string;
}

export function buildAnnotatorRubric(template: AnnotatorTemplate): string {
  return String.raw`
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
    "annotatorConfidence": 90,
    "category": "security"
  }
]
` + '```' + `

Field rules:
- ` + '`id`' + `: assign sequentially F1, F2, F3, ... (must be unique).
- ` + '`severity`' + `: one of "critical" | "high" | "medium" | "low" — YOUR
   final judgment. The worker's value is a hint; calibrate to actual impact.
- ` + '`claim`' + `: one-sentence summary.
- ` + '`evidence`' + `: REQUIRED, ≥20 chars, MUST be a verbatim quote from the
   worker's output.
- ` + '`suggestion`' + `: optional; quote or paraphrase the worker's recommended fix.
- ` + '`annotatorConfidence`' + `: integer 0-100. How confident YOU are
   that the finding is correct, on-brief, and well-grounded.
- ` + '`category`' + `: optional, one of: "missing_test" | "scope_creep" |
   "incomplete_impl" | "style_lint" | "security" | "performance" |
   "maintainability" | "doc_gap" | "doc_drift" | "contract_violation" |
   "coverage_gap" | "dead_code" | "queue_hygiene" | "other".

## Tool-specific evidence rule (apply when judging "well-grounded")

` + template.evidenceRule + `

## Tool-specific scope rule (apply when judging "on-brief")

` + template.scopeRule + `

If the worker raised NO issues, return ` + '`[]`' + `. Surrounding prose is
allowed but ignored by the parser — only the LAST ` + '```json' + ` block is read.
`.trim();
}
