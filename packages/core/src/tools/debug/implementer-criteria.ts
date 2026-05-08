/**
 * Debug-specific implementer criteria.
 *
 * Debug is hypothesis-driven root-cause investigation. The shared
 * "do not speculate about caller behavior" rule directly contradicts
 * debug's job — debugging IS speculation, narrowed by evidence.
 * Cross-file tracing is required, not forbidden.
 */

export const EVIDENCE_RULE_DEBUG = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Each finding is a hypothesis with a supporting evidence chain.',
  '- Evidence: the reproducer + the code path traced from failure point to suspected cause + observed output.',
  '- Hypothesis-level findings with PARTIAL evidence are valid — that\'s how root-causing works. Show your reasoning chain.',
  '- Severity reflects evidence strength: confirmed root cause = `high`; plausible candidate = `medium`; ruled out = `low` (or note in summary, not as a Finding).',
].join('\n');

export const SCOPE_RULE_DEBUG = [
  'Scope:',
  '- Follow the failure path wherever it leads. Cross-file tracing is required.',
  '- Out of scope: applying fixes (debug is read-only — propose, do not apply); rewriting code; auditing unrelated subsystems; broadening into general code review.',
].join('\n');

export const ANNOTATOR_AWARENESS_DEBUG = [
  'After your output, an annotator validates each finding against this debug rubric:',
  '- Is each finding a hypothesis or evidence chain (not an unrelated observation)?',
  '- Does the reasoning chain logically connect the cited evidence to the hypothesis?',
  '- Did you propose fixes without applying them (read-only contract)?',
  '- Is severity calibrated to evidence strength?',
  'Self-check before emitting. Findings that fail any check are downgraded or dropped.',
].join('\n');
