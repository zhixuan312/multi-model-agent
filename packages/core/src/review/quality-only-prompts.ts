/**
 * Quality-only review prompts for the 5 read-only mma-* routes (3.10.5+).
 *
 * The reviewer receives ONLY the implementer's free-form markdown narrative
 * and the original brief. It must:
 *  1. Read the worker's narrative.
 *  2. Identify every distinct issue/finding/checklist-item the worker raised.
 *  3. Assign sequential ids (F1, F2, ...) — even if the worker numbered them,
 *     the reviewer re-numbers from 1 to ensure uniqueness.
 *  4. Set `severity` to its OWN final 4-tier judgment {critical, high, medium,
 *     low}. The reviewer is authoritative — there is no separate
 *     `reviewerSeverity` field. Map worker-stated "mid" -> "medium". When
 *     the worker did not state a severity, judge from impact.
 *  5. Score each finding's reviewerConfidence (0-100) — how confident YOU
 *     would be defending the finding's correctness if challenged.
 *  6. Quote evidence VERBATIM (≥20 chars) from the worker's output. The
 *     downstream parser flags non-substring quotes via
 *     `evidenceGrounded:false` but never drops findings.
 *  7. Emit ONE fenced JSON code block as the LAST block in your response.
 *
 * If the worker raised zero issues, emit `[]` and stop.
 */

interface PromptContext {
  workerOutput: string;
  brief: string;
}

const RUBRIC_TEMPLATE = String.raw`
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
    "reviewerConfidence": 90
  },
  {
    "id": "F2",
    "severity": "medium",
    "claim": "Auth check missing on /admin endpoint",
    "evidence": "router.get('/admin', adminHandler) — no auth middleware applied",
    "reviewerConfidence": 60
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
- ` + '`reviewerConfidence`' + `: integer 0-100. How confident YOU (reviewer) are
   that the finding is correct, on-brief, and well-grounded:
     80-100: defend without hesitation
     60-79:  plausible, minor gaps
     40-59:  thin evidence
     20-39:  weak / off-brief
      0-19:  unsupported / fabricated

If the worker raised NO issues, return ` + '`[]`' + `. Surrounding prose is allowed
but ignored by the parser — only the LAST ` + '```json' + ` block is read.
`.trim();

function buildPrompt(role: string, onBriefCheck: string, ctx: PromptContext): string {
  return `You are reviewing a ${role} produced by a worker.

The user requested a ${role}. The brief was:

${ctx.brief}

## On-brief check (per finding)

${onBriefCheck}

## Worker output to extract findings from

${ctx.workerOutput}

${RUBRIC_TEMPLATE}`;
}

export function buildAuditQualityPrompt(ctx: PromptContext): string {
  return buildPrompt(
    'audit',
    'For each finding, ask: is this the kind of issue the audit asked for? A security audit should produce security findings, not style nits.',
    ctx,
  );
}

export function buildReviewQualityPrompt(ctx: PromptContext): string {
  return buildPrompt(
    'code review',
    'For each finding, ask: is this within the requested focus area? A security review should produce security findings, not formatting nits.',
    ctx,
  );
}

export function buildVerifyQualityPrompt(ctx: PromptContext): string {
  return buildPrompt(
    'verification report',
    'Each finding should map to one checklist item with evidence the criterion was met or unmet. Flag findings that do not correspond to any checklist item, or whose evidence does not actually demonstrate the claimed pass/fail status.',
    ctx,
  );
}

export function buildInvestigateQualityPrompt(ctx: PromptContext): string {
  return buildPrompt(
    'codebase investigation',
    'Each finding should be relevant to the question. Findings may be code-level (file:line cited in evidence) or project-level synthesis (what was searched, what was not found). Flag findings whose evidence does not support the claim or whose claim drifts from the question.',
    ctx,
  );
}

export function buildDebugQualityPrompt(ctx: PromptContext): string {
  return buildPrompt(
    'debugging hypothesis',
    'Each finding should be a hypothesis, root-cause claim, or evidence (reproducer, error pattern, code path). Flag findings that do not logically follow from cited evidence or that exceed what the trace actually shows.',
    ctx,
  );
}
