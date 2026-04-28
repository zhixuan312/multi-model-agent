/**
 * Quality-only review prompts for the 5 read-only mma-* routes.
 *
 * Each prompt asks the reviewer:
 *   (a) Schema check: confirm worker emitted a well-formed findings[] array.
 *   (b) Per-finding judgment: is the finding the kind requested AND grounded?
 *
 * If schema check fails, return changes_required immediately and skip per-finding review.
 */

interface PromptContext {
  workerOutput: string;
  brief: string;
}

const SCHEMA_PREAMBLE = `
First, confirm the worker's output includes a well-formed \`findings[]\` array (a JSON array, possibly empty if the worker found nothing, but present as a parseable structure). If the array is missing, malformed, or returned as prose only, return \`changes_required\` with the reason "missing or malformed findings array" and do NOT proceed to per-finding review.
`.trim();

const COMMON_TAIL = `
When re-reading files, treat \`findings[].line\` as 1-indexed (matches editor convention). For multi-line findings, \`line\` points to the start of the cited region; use \`sourceQuote\` (when present) for the full text.

Output a single verdict: \`approved\` (if every finding is on-brief and grounded) or \`changes_required\` (with per-finding feedback identifying which findings failed which check).
`.trim();

export function buildAuditQualityPrompt(ctx: PromptContext): string {
  return `${SCHEMA_PREAMBLE}

The user requested an audit. The brief was:

${ctx.brief}

The worker produced a \`findings[]\` array. For each finding:
(a) Is it of the requested audit type? (e.g., security audit -> security finding, not style nit)
(b) Re-read the cited file at \`findings[].file\` (the audit target document) at the given \`findings[].line\`. Is the worker's claim true about that text?

Flag findings that are off-type, vague, unsupported, or misread the source.

${COMMON_TAIL}

Worker output:
${ctx.workerOutput}`;
}

export function buildReviewQualityPrompt(ctx: PromptContext): string {
  return `${SCHEMA_PREAMBLE}

The user requested a code review. The brief was:

${ctx.brief}

The worker produced a \`findings[]\` array. For each finding:
(a) Is it within the requested focus area? (e.g., security review -> security finding, not formatting nit)
(b) Re-read the cited file/line. Does the worker's claim correctly describe the code's behavior?

Flag findings that misread the code or stretch beyond what the cited lines support.

${COMMON_TAIL}

Worker output:
${ctx.workerOutput}`;
}

export function buildVerifyQualityPrompt(ctx: PromptContext): string {
  return `${SCHEMA_PREAMBLE}

The user provided a checklist of acceptance criteria. The brief was:

${ctx.brief}

The worker produced a \`findings[]\` array, where each finding maps to one checklist item the worker judged as either met (no finding emitted, or a 'low'-severity confirmation) or unmet (a 'high'/'medium'-severity finding describing what's missing). For each finding:
(a) Does the finding correspond to a real checklist item from the brief?
(b) Re-read the cited evidence in \`findings[].file\` and \`findings[].sourceQuote\` (when present). Does the cited evidence actually demonstrate the worker's claim about that checklist item?

Also: confirm every checklist item from the brief is accounted for — if any checklist item has no corresponding entry in \`findings[]\` (and no implicit "met" claim), flag it.

${COMMON_TAIL}

Worker output:
${ctx.workerOutput}`;
}

export function buildInvestigateQualityPrompt(ctx: PromptContext): string {
  return `${SCHEMA_PREAMBLE}

The user asked a question. The brief was:

${ctx.brief}

The worker produced a synthesis with \`findings[]\` (each finding may have \`file\`, \`line\`, or both null for project-level claims). For each finding:
(a) Is the finding relevant to the question?
(b) When \`findings[].file\` is non-null, confirm the file exists. When \`findings[].line\` is also non-null, treat it as 1-indexed and re-read that location. Does the cited content support the finding's \`claim\`?

Flag findings whose citations are fabricated, misquoted, or stretched beyond what the source supports. Also flag claims that aren't backed by any cited evidence.

${COMMON_TAIL}

Worker output:
${ctx.workerOutput}`;
}

export function buildDebugQualityPrompt(ctx: PromptContext): string {
  return `${SCHEMA_PREAMBLE}

The user reported a failure. The brief was:

${ctx.brief}

The worker produced a hypothesis and findings about cited evidence (reproducer, error pattern, code paths). For each cited piece of evidence:
(a) Is it relevant to the reported failure?
(b) Does the hypothesis logically follow from the evidence, or does it exceed what the trace actually shows?

Flag claims that aren't supported by the cited evidence.

${COMMON_TAIL}

Worker output:
${ctx.workerOutput}`;
}
