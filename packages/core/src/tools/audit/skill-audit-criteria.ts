// Audit subtype: 'skill' — skill-file reader-effectiveness audit.
// A finding is a place where the skill, as written, would cause a competent
// reader to dispatch the wrong call, miss a path of use, or fall for a
// foreseeable anti-pattern.
import type { CriterionEntry } from '../criteria-types.js';
import { parseCriteria } from '../criteria-types.js';
import type { RouteSemantics } from '../parallel-criteria-prompt.js';

export const SKILL_AUDIT_PURPOSE_ORIENTATION = [
  'Why this audit exists:',
  'A skill is the markdown a caller reads to decide whether to route a request to a tool and how to construct that request. A finding here is a place where the skill, as written, would cause a competent reader to dispatch the wrong call, miss a path of use, or fall for a foreseeable anti-pattern.',
  '',
  'For your output to clear that bar, every Finding must answer:',
  '- Issue: the gap or ambiguity, quoting the exact skill section (heading + line).',
  '- Suggestion: the missing or replacement text the skill needs.',
  '',
  'The completion test: would a competent reader given ONLY this skill be able to construct a correct request and avoid the named anti-patterns? If a Finding does not change that answer from "no" to "yes" when applied, it is below the bar — omit it.',
].join('\n');

export const EVIDENCE_RULE_SKILL_AUDIT = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Quote the exact section heading + offending line (or the absence — name what is missing AND where it should appear).',
  '- For when_to_use overlap findings: name the sibling skill that overlaps + quote both `when_to_use` lines.',
  '- For input-shape findings: name the field that lacks documentation + quote the schema or surface where the field is exposed.',
  '- For link-integrity findings: name the broken link + the file that should exist at that path.',
  '- Severity binding: critical = wrong-tool routing; high = wrong-field dispatch; medium = reader hesitation; low = stylistic / metadata fix.',
].join('\n');

export const SCOPE_RULE_SKILL_AUDIT = [
  'Scope:',
  '- In scope: when_to_use specificity, input-shape completeness, output-shape contract, anti-pattern coverage, recipe-vs-skill scope discipline, version frontmatter, link integrity.',
  '- Out of scope: implementation details of the tool itself (those belong in source code, not the skill), opinions on the underlying tool design, prose stylistic preferences that do not affect reader effectiveness.',
  '- Multi-tool flows (recipes that span 2+ skills) are out of scope for individual skill files and belong in `multi-model-agent` SKILL.md\'s recipes section — flag in-skill recipes as RECIPE-VS-SKILL-SCOPE findings.',
].join('\n');

export const ANNOTATOR_AWARENESS_SKILL_AUDIT = [
  '(N/A — your output is consumed verbatim by the user; there is no downstream annotator dedup step on this subtype.)',
].join('\n');

const SKILL_AUDIT_FAILURE_MODES = [
  '1. WHEN-TO-USE-SPECIFICITY — The `when_to_use` frontmatter cleanly distinguishes this skill from sibling skills. Overlap with another `mma-*` skill without a tiebreaker is a finding.',
  '2. INPUT-SHAPE-COMPLETENESS — Required JSON fields are documented with name + type + constraint + example. A reader can write a valid request from the skill text alone. Missing fields, types, or constraints flag.',
  '3. OUTPUT-SHAPE-CONTRACT — The terminal envelope shape the caller will consume is described, including the structured-report shape and which fields are guaranteed vs optional.',
  '4. ANTI-PATTERN-COVERAGE — Foreseeable misuses are called out with a corrective ("use X instead"). Anti-patterns mentioned without a corrective flag.',
  '5. RECIPE-VS-SKILL-SCOPE — The skill documents a single tool, not a multi-step recipe spanning multiple tools. Multi-tool flows belong in `multi-model-agent` SKILL.md\'s recipes section.',
  '6. VERSION-FRONTMATTER — `name` / `description` / `when_to_use` / `version` frontmatter is present and well-formed. `version` is the literal string `"0.0.0-unreleased"` before npm publish injection.',
  '7. LINK-INTEGRITY — Internal cross-references (`./_shared/...`, `mma-other-skill`) point at files that exist; external links are not load-bearing for the skill\'s correctness.',
].join('\n');

export const SKILL_AUDIT_CRITERIA: readonly CriterionEntry[] = parseCriteria(SKILL_AUDIT_FAILURE_MODES);

export const SKILL_AUDIT_SEMANTICS: RouteSemantics = {
  goalLine: 'Find ALL ways this skill, as written, would cause a competent reader to dispatch the wrong call, miss a path of use, or fall for a foreseeable anti-pattern — viewed through this criterion.',
  emptyOutcomeLine: 'If THIS criterion does not surface a real gap in the skill, respond with the literal text "No findings for this criterion." — that is a valid outcome on a clean skill file.',
  findingMeaningParagraph: 'A finding is a PLACE WHERE THE SKILL TEXT FAILS THE READER-EFFECTIVENESS TEST viewed through this criterion. Title = the failing section (or its anchor). Severity reflects whether a reader would route to the wrong tool, dispatch with wrong fields, hesitate / re-read, or just notice a stylistic nit.',
  severityMeanings: {
    critical: 'would route the reader to the wrong tool entirely — e.g. when_to_use overlaps a sibling skill with no tiebreaker, or the description names the wrong tool category.',
    high: 'would dispatch with wrong fields — input shape incomplete, required field undocumented, JSON example wrong/missing.',
    medium: 'would make a reader hesitate or re-read — anti-pattern mentioned without correction, recipe-vs-skill scope unclear, version frontmatter malformed.',
    low: 'stylistic / link / metadata fix; does not affect dispatch correctness.',
  },
  mustEmitAtLeastOne: false,
  legalOutcomes: ['found', 'clean'] as const,
};
