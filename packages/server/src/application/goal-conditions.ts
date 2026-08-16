import type { TaskType } from '@zhixuan92/multi-model-agent-core';
import { REFINER_SCHEMAS } from '@zhixuan92/multi-model-agent-core';

/**
 * Types whose refiner answer actually carries a `findings` array, read from the schemas rather
 * than listed here.
 *
 * The reviewer goal is emitted for EVERY type and demanded "you have checked for hallucinated
 * findings", "every finding cites actual file:line" and "you have checked weight calibration" —
 * on `delegate` (`{status, notes}`), `execute_plan` (`{tasks, notes}`) and `journal_record`
 * (`{recorded, failed}`), none of which has a finding or a weight. The Stop hook holds the worker
 * until the goal reads as satisfied, so those reviewers were spending turns auditing a field that
 * does not exist in their output.
 */
const FINDINGS_TYPES: ReadonlySet<string> = new Set(
  Object.entries(REFINER_SCHEMAS)
    .filter(([, schema]) => {
      const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape;
      return shape !== undefined && 'findings' in shape;
    })
    .map(([type]) => type),
);

/**
 * Build a goal condition string for the Stop hook. This keeps the agent
 * working until it has covered all criteria defined in the skill file.
 */
export function buildGoalCondition(type: TaskType, role: 'implementer' | 'reviewer', skillContent: string): string | undefined {
  if (role === 'reviewer') {
    return [
      'You have verified every criterion the implementer was supposed to cover.',
      ...(FINDINGS_TYPES.has(type)
        ? [
            'You have checked for hallucinated findings (claims without evidence in the source material).',
            'You have validated evidence quality (every finding cites actual file:line or quoted text).',
            'You have checked weight calibration against the skill definitions.',
          ]
        : []),
      'You have verified the implementer\'s draft and output the refined answer in the same JSON format as the implementer.',
      'No findings, verdict, or meta-commentary -- only the final answer in a ```json fenced block.',
    ].join(' ');
  }

  switch (type) {
    case 'audit': {
      const countMatch = skillContent.match(/(\d+)\s+(?:Verification Criteria|perspectives|failure modes|Execution Steps)/i);
      const count = countMatch ? countMatch[1] : 'all';
      return [
        `You have evaluated the document against ALL ${count} criteria one by one.`,
        // NOT a scratch file: `audit` is registered `read-only`, so the confinement hook denies
        // every write tool. This goal is enforced by the Stop hook, which re-blocks the worker
        // until it holds — so naming a file the sandbox forbids held the worker against a
        // condition it could not satisfy. The audit prompts were corrected to say "working
        // memory"; this is the same instruction one layer up.
        'For each criterion, you recorded findings in working memory before moving to the next.',
        'Every criterion either has findings with quoted evidence, or an explicit "No findings for this criterion." entry.',
        'You have consolidated those findings into the final JSON output block.',
        `The criteriaCovered array in your output lists all ${count} criteria.`,
      ].join(' ');
    }
    case 'investigate':
      return [
        'You have applied ALL 5 investigation perspectives: direct-symbol-trace, caller-analysis, test-driven, cross-file dependency-map, documentation/comment-lens.',
        'Every finding cites file:line from files you actually read (no training-data citations).',
        'Absent things are evidenced with "searched <pattern> in <path>, no matches."',
        'You have calibrated weight (critical/high/medium/low) based on evidence strength.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'review':
      return [
        'You have swept ALL 10 review categories: verification-gap, cross-reference-ripple, pre-existing-vs-regression, missing-edge-case, ordering-concurrency, resource-cleanup-gap, backward-compat-break, safety-regression, efficiency-regression, implicit-contract.',
        'Cross-file findings cite both the change site AND the broken caller.',
        'Pre-existing bugs are separated from new regressions.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'debug':
      return [
        'You have applied ALL 5 investigation angles: symptom-location, recent-change, test-failure, reproduction, concurrency-configuration.',
        'Your trace chain has at least 3 evidence points: symptom → intermediate state → cause, each with file:line.',
        'You have proposed a fix (read-only — describe, do not apply).',
        'You have stated a falsifier (how the maintainer verifies the fix).',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'research':
      return [
        'You have searched from ALL 5 perspectives: primary-sources, practitioner-consensus, recent-developments, counter-perspectives, cross-domain.',
        'Every finding cites a real source with URL or identifier.',
        'Source tier (primary/practitioner/recent) is indicated.',
        'You have produced the required JSON output block with sources, findings, and synthesis.',
      ].join(' ');
    case 'delegate':
      return [
        'You have implemented ALL requested changes in the task description.',
        'Only the declared target paths were modified (no scope creep).',
        'If tests exist for the changed area, you have verified they pass.',
        'You have produced the required JSON output block listing tasks completed and files changed.',
      ].join(' ');
    case 'execute_plan':
      return [
        'You have satisfied every dispatched Contract Task\'s Contract (Inputs/Request, Outputs/Response, Data mapping, Errors, Behavior/invariants) and made its plan-authored checks, if any, pass.',
        'Any plan-authored checks were already materialized in your workspace at their declared paths; you implemented against them and did not create, move, modify, weaken, delete, or overwrite them. A task with no declared check still needed its Contract satisfied in full.',
        'You chose your own implementation approach to satisfy the contract — the plan contains no implementation code, so there is nothing to copy verbatim.',
        'If a contract defect (including an authored check that contradicts the contract) blocked you, you reported it by name instead of silently working around it or weakening the check.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'journal_record':
      return [
        'For EVERY submitted record you have emitted exactly one structured decision (create/refine/supersede/merge), judging only from the engine-supplied candidates.',
        'Each decision classifies the entry by type (decision/design/behavior/process/knowledge/style) and carries a normalized lowercase-kebab `topic` naming the primary subject.',
        'refine and supersede decisions name the existing targetNodeId; create/refine decisions carry the full node content (title, description, context, consequences, tags, links).',
        'You have NOT written node files, allocated ids, or edited index.md/log.md — the deterministic engine applies your decisions.',
        'You have produced the required JSON decision array as the final output block.',
      ].join(' ');
    case 'journal_recall':
      return [
        'You have judged ONLY the engine-supplied candidate set — you did not scan the journal yourself — and every cited node is present in that set.',
        'Superseded candidates are excluded unless `includeHistory` is true.',
        'Each result includes the learning, its context, a relevance assessment, the candidate\'s normalized lowercase-kebab `topic`, and its boolean `fallback` label (in-topic `false`, cross-topic fallback `true`) preserved verbatim from the engine.',
        'The `answer` synthesizes the cited candidates into plain English a human can act on — what this project already learned or decided that bears on the question, not a node-ID dump.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'spec':
      return [
        'You have read the structured design decisions from the input.',
        'You have written a complete spec file with YAML frontmatter and the requested canonical sections only, preserving canonical order.',
        'The canonical section identifiers are: Context, Problem, Goals & Requirements, Alternatives, Technical Design, Testing Plan, Risks & Mitigations, User Stories & Tasks; the displayed heading text uses their neutral labels, so Technical Design renders as "Approach, Method & Structure", Testing Plan as "Verification Plan", and User Stories & Tasks as "Stakeholders & Work".',
        'You have proposed the whole deliverable contract in the frontmatter (state: proposed, kind, audience, artifacts, acceptance criteria each with an explicit method, a why rationale, and a reference, and disposition), derived in plain language from the caller\'s own answers, never demanded preformed from the caller.',
        'No placeholder language exists (no TBD, TODO, or vague verbs).',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'plan':
      return [
        'You have read the spec and explored the target material to discover ground truth at HEAD.',
        'You have written a complete plan file with Goal/Architecture/Tech Stack header and File Structure section.',
        'Every task is a deliverable-neutral Contract Task: a numbered "### Task <roman>-<n>:" heading followed by a "**Output:**" line and a "**Dependencies:**" line — never an implementation-file list.',
        'Every task states all five Contract bullets, in order: Inputs / Request, Outputs / Response, Data mapping, Errors, Behavior / invariants.',
        'A task MAY declare a "Checks (plan-authored" block ONLY when its technical AC admits a deterministic check, with, for each declared check, exactly one Check:, one complete fenced source block, and one Run: command containing no shell metacharacters; a task with no deterministic check declares no Checks block at all, and that is not an error.',
        'Every task ends with the exact line "**Plan boundary:** final deliverable content is not in this plan." — you do not write implementation code or final deliverable content in the plan.',
        'Every path was verified against the target material.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'orchestrate':
      return [
        'You have fully processed the prompt and produced the requested output.',
        'If an output format was specified, your response conforms to that format.',
        'Your response is the deliverable — no meta-commentary wrapping it.',
      ].join(' ');
    default:
      // Unreachable today: the twelve cases above are exactly `TASK_TYPES`. Kept as an
      // EXHAUSTIVENESS check rather than a generic fallback string — a thirteenth task type
      // should fail to compile here, naming the omission, instead of silently shipping with a
      // goal condition that says nothing about what it must cover. A catch-all sentence would
      // let a new route's Stop hook pass on the first plausible-looking output.
      return assertEveryTaskTypeHandled(type);
  }
}

/** Fails to COMPILE when a `TaskType` gains a member with no goal condition above. */
function assertEveryTaskTypeHandled(type: never): never {
  throw new Error(`no goal condition defined for task type '${String(type)}'`);
}
