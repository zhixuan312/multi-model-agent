import type { TaskType } from '@zhixuan92/multi-model-agent-core';

/**
 * Build a goal condition string for the Stop hook. This keeps the agent
 * working until it has covered all criteria defined in the skill file.
 */
export function buildGoalCondition(type: TaskType, role: 'implementer' | 'reviewer', skillContent: string): string | undefined {
  if (role === 'reviewer') {
    return [
      'You have verified every criterion the implementer was supposed to cover.',
      'You have checked for hallucinated findings (claims without evidence in the source material).',
      'You have validated evidence quality (every finding cites actual file:line or quoted text).',
      'You have checked weight calibration against the skill definitions.',
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
        'For each criterion, you wrote findings to the scratch file before moving to the next.',
        'Every criterion either has findings with quoted evidence, or an explicit "No findings for this criterion." entry.',
        'You have read the scratch file and consolidated into the final JSON output block.',
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
        'You have swept ALL 10 review categories: test gap, cross-file ripple, pre-existing-vs-regression, missing edge case, race/concurrency, resource leak, backward-compat break, security regression, performance regression, implicit-contract assumption.',
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
        'You have satisfied every dispatched Contract Task\'s Contract (Inputs/Request, Outputs/Response, Data mapping, Errors, Behavior/invariants) and made its plan-authored Acceptance tests pass.',
        'The plan-authored Acceptance tests were already materialized in your workspace at their declared paths; you implemented against them and did not create, move, modify, weaken, delete, or overwrite them.',
        'You chose your own implementation approach to satisfy the contract — the plan contains no implementation code, so there is nothing to copy verbatim.',
        'If a contract defect (including an authored test that contradicts the contract) blocked you, you reported it by name instead of silently working around it or weakening the test.',
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
        'You have read the spec and explored the codebase to discover ground truth at HEAD.',
        'You have written a complete plan file with Goal/Architecture/Tech Stack header and File Structure section.',
        'Every task is a frozen Contract Task: a numbered "### Task <roman>-<n>:" heading with an inline "**Files:** ... Test:" field naming its plan-authored acceptance-test path(s).',
        'Every task states all five Contract bullets, in order: Inputs / Request, Outputs / Response, Data mapping, Errors, Behavior / invariants.',
        'Every task has an "Acceptance tests (plan-authored" block with, for each declared path, exactly one Path:, one complete fenced source block, and one Run: command containing no shell metacharacters.',
        'Every task ends with the exact line "**Implementation:** left to the executor — no code in the plan." — you do not write implementation code in the plan.',
        'Every file path was verified against the codebase.',
        'You have produced the required JSON output block.',
      ].join(' ');
    case 'orchestrate':
      return [
        'You have fully processed the prompt and produced the requested output.',
        'If an output format was specified, your response conforms to that format.',
        'Your response is the deliverable — no meta-commentary wrapping it.',
      ].join(' ');
    default:
      return 'You have completed the task as specified in the skill instructions and produced the required output.';
  }
}
