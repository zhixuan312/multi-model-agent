/**
 * Quality-only review prompts for the 5 read-only mma-* routes (3.8.1+).
 *
 * Each prompt asks the reviewer to ANNOTATE every worker finding with:
 *  - reviewerConfidence: integer 0–100, how confident YOU (reviewer) are that
 *    this finding is correct, on-brief, and well-grounded in the evidence.
 *  - reviewerSeverity (optional): only set when you disagree with the worker's
 *    severity. Workers tend to inflate; use this to dial down.
 *
 * The reviewer returns a single ```json fenced block containing a JSON array
 * of {id, reviewerConfidence, reviewerSeverity?} objects, one per worker
 * finding (matched by id). NO verdict, NO gate, NO rework signal.
 */

import type { WorkerFinding } from '../executors/_shared/findings-schema.js';

interface PromptContext {
  workerOutput: string;
  brief: string;
  workerFindings: WorkerFinding[];
}

const RUBRIC = `
## How to score \`reviewerConfidence\` (integer 0-100)

You are scoring whether YOU would defend this finding if pushed. Not severity.
Not the worker's self-confidence.

  80-100: evidence directly supports the claim, on-brief, defend without hesitation
  60-79:  evidence supports claim with minor gaps, on-brief, plausible
  40-59:  claim plausible but evidence thin, partial, or requires inference
  20-39:  claim weak, evidence does not back it up, OR off-brief
   0-19:  unsupported, contradicted, fabricated, OR completely off-brief

## How to use \`reviewerSeverity\` (optional)

Only set when you DISAGREE with the worker's \`severity\`. Workers tend to
inflate ("everything is high"); use \`reviewerSeverity\` to dial down. Omit
when you agree.

## Output format (REQUIRED)

Respond with exactly one fenced JSON code block. The block must contain a
JSON array of objects, one entry per worker finding (matched by \`id\`). Example:

\`\`\`json
[
  { "id": "F1", "reviewerConfidence": 85 },
  { "id": "F2", "reviewerConfidence": 35, "reviewerSeverity": "low" },
  { "id": "F3", "reviewerConfidence": 70 }
]
\`\`\`

Every worker finding id must appear exactly once. No extra ids. No missing
ids. Surrounding prose is allowed but ignored by the parser.
`.trim();

function renderFindings(findings: WorkerFinding[]): string {
  return JSON.stringify(findings, null, 2);
}

export function buildAuditQualityPrompt(ctx: PromptContext): string {
  return `You are reviewing an audit produced by a worker.

The user requested an audit. The brief was:

${ctx.brief}

## On-brief check (per finding)

For each worker finding, ask: is this the kind of issue the audit asked for?
A security audit should produce security findings, not style nits.

## Worker findings to annotate

\`\`\`json
${renderFindings(ctx.workerFindings)}
\`\`\`

${RUBRIC}`;
}

export function buildReviewQualityPrompt(ctx: PromptContext): string {
  return `You are reviewing a code review produced by a worker.

The user requested a code review. The brief was:

${ctx.brief}

## On-brief check (per finding)

For each worker finding, ask: is this within the requested focus area?
A security review should produce security findings, not formatting nits.

## Worker findings to annotate

\`\`\`json
${renderFindings(ctx.workerFindings)}
\`\`\`

${RUBRIC}`;
}

export function buildVerifyQualityPrompt(ctx: PromptContext): string {
  return `You are reviewing a verification report produced by a worker.

The user provided a checklist of acceptance criteria. The brief was:

${ctx.brief}

## On-brief check (per finding)

Each finding should map to one checklist item with evidence the criterion was
met or unmet. Flag findings that don't correspond to any checklist item, or
whose evidence doesn't actually demonstrate the claimed pass/fail status.

## Worker findings to annotate

\`\`\`json
${renderFindings(ctx.workerFindings)}
\`\`\`

${RUBRIC}`;
}

export function buildInvestigateQualityPrompt(ctx: PromptContext): string {
  return `You are reviewing a codebase investigation produced by a worker.

The user asked a question. The brief was:

${ctx.brief}

## On-brief check (per finding)

Each finding should be relevant to the question. Findings may be code-level
(file:line cited in evidence) or project-level synthesis (what was searched,
what was not found). Flag findings whose evidence does not support the claim
or whose claim drifts from the question.

## Worker findings to annotate

\`\`\`json
${renderFindings(ctx.workerFindings)}
\`\`\`

${RUBRIC}`;
}

export function buildDebugQualityPrompt(ctx: PromptContext): string {
  return `You are reviewing a debugging hypothesis produced by a worker.

The user reported a failure. The brief was:

${ctx.brief}

## On-brief check (per finding)

Each finding should be a hypothesis, root-cause claim, or evidence
(reproducer, error pattern, code path). Flag findings that don't logically
follow from cited evidence or that exceed what the trace actually shows.

## Worker findings to annotate

\`\`\`json
${renderFindings(ctx.workerFindings)}
\`\`\`

${RUBRIC}`;
}
