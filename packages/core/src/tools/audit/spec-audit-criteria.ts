// Audit subtype: 'spec' — requirement-prose executability audit.
// A finding is a place where the spec's prose, executed literally, would
// produce the wrong outcome or paralyze a downstream worker.
import type { CriterionEntry } from '../criteria-types.js';
import { parseCriteria } from '../criteria-types.js';
import type { RouteSemantics } from '../parallel-criteria-prompt.js';

export const SPEC_AUDIT_PURPOSE_ORIENTATION = [
  'Why this audit exists:',
  'A spec is the prose that says what the system shall do. A finding here is a place where the prose, executed literally, would produce the wrong outcome or paralyze the executor. The completion test: would a downstream worker reading only this spec be able to build the right thing without coming back for clarification?',
  '',
  'For your output to clear that bar, every Finding must answer:',
  '- Issue: the gap or contradiction in one paragraph, quoting the exact prose snippet.',
  '- Suggestion: the missing sentence the spec needs in order to be executable.',
  '',
  'The completion test: would a downstream executor reading ONLY this spec be able to build the right thing without coming back for clarification? If a Finding does not change that answer from "no" to "yes" when applied, it is below the bar — omit it.',
].join('\n');

export const EVIDENCE_RULE_SPEC_AUDIT = [
  'Evidence grounding (REQUIRED for every finding):',
  '- Quote the exact `shall` / `must` / `should` clause that contains the gap (or the heading the gap sits under).',
  '- For requirement conflicts: quote BOTH conflicting clauses.',
  '- For assumption-exposure findings: quote the hidden assumption + name what would break if it does not hold.',
  '- For acceptance-criteria-coverage findings: name the requirement that lacks a mapping AND state whether the spec calls out a reason it is non-testable.',
  '- A "the spec seems to imply" claim without a quoted clause is NOT evidence — drop it.',
  '- Severity binding: critical = literal execution silently ships wrong behavior; high = executor blocked; medium = clarification round forced; low = stylistic / metadata gap.',
].join('\n');

export const SCOPE_RULE_SPEC_AUDIT = [
  'Scope:',
  '- In scope: requirement testability, scope explicitness AND decomposability, acceptance-criteria coverage, non-functional capture, requirement conflicts, decision trace, hidden assumptions, unresolved authoring placeholders, and presence of architectural decomposition (components, data flow, error handling, testing strategy).',
  '- Out of scope: implementation details (those belong in a plan, not a spec — flag scope leak into implementation as a SCOPE-EXPLICITNESS-AND-DECOMPOSABILITY finding, not a general comment), stylistic prose preferences, opinions on whether the spec is "good", lens-style audits (security or performance focus belongs in free-text prompt, not in spec subtype).',
  '- IMPLICIT requirements embedded inside a clause ARE in scope. Example: "shall validate the token" implicitly requires "what counts as valid" — if that is undefined, flag it as REQUIREMENT-TESTABILITY (do not split into two findings).',
].join('\n');

export const ANNOTATOR_AWARENESS_SPEC_AUDIT = [
  '(N/A — your output is consumed verbatim by the user; there is no downstream annotator dedup step on this subtype.)',
].join('\n');

const SPEC_AUDIT_FAILURE_MODES = [
  '1. REQUIREMENT-TESTABILITY — Every "shall" / "must" / "should" requirement has a concrete, observable outcome that a test can assert. Vague verbs ("supports", "handles", "is reliable") without a measurable outcome flag as findings.',
  '2. SCOPE-EXPLICITNESS-AND-DECOMPOSABILITY — In-scope and out-of-scope items are explicit AND the stated scope is sized for a single implementation plan. Two sub-checks: (a) EXPLICITNESS — implied scope (mentioned-once-then-dropped, or referenced without definition) is a finding; in-scope and out-of-scope lists should appear as a dedicated section, not be inferred from prose. (b) DECOMPOSABILITY — the spec describes ONE buildable feature, not multiple independent subsystems bundled together. Signals that decomposition is needed (severity HIGH): the spec mixes orthogonal subsystems (e.g. chat + file storage + billing); the spec has more than one top-level "Goal" or implies multiple independently releasable units; the architecture section names more than ~5 net-new modules across non-overlapping concerns. Suggested fix on a multi-subsystem spec: split into sub-project specs and brainstorm/plan each independently, citing the brainstorming-skill decomposition guidance.',
  '3. ACCEPTANCE-CRITERIA-COVERAGE — Every requirement maps to at least one acceptance criterion (or the spec calls out it is non-acceptance-testable and says why). Missing mapping is a finding.',
  '4. NON-FUNCTIONAL-CAPTURED — Non-functional constraints (latency, security, observability, accessibility, scale) are stated where load-bearing, not assumed silently. Silent assumption is a finding.',
  '5. REQUIREMENT-CONFLICT — Two requirements that cannot simultaneously hold (e.g. "respond in <50ms" + "validate against the remote registry on every call") are surfaced.',
  '6. DECISION-TRACE — Decisions that affect downstream implementation (algorithm choice, data shape, integration point) are stated with the reasoning, not just the outcome. Outcome-only is a finding.',
  '7. ASSUMPTION-EXPOSURE — Hidden assumptions about caller behaviour, environment, or pre-existing state are made explicit so the executor can verify them.',
  '8. PLACEHOLDER-SCAN — The spec contains no unresolved authoring placeholders that would block planning. Flag occurrences of `TBD`, `TODO`, `[fill in]`, `[to be decided]`, `???`, empty section bodies under a heading (a heading with no content beneath it before the next heading), bulleted lists ending in `…` or "more to come", and tables with empty cells in load-bearing columns. Severity binding: HIGH when the placeholder sits on a load-bearing section (a requirement, an architecture component, an acceptance criterion); MEDIUM elsewhere; LOW on metadata-only sections (author, revision history). Suggested fix: resolve the placeholder before moving to writing-plans, or mark the section explicitly as "out of scope for this iteration" with a forward reference. Evidence is the exact placeholder quote with its section heading.',
  '9. DESIGN-DECOMPOSITION-PRESENT — A spec must give the planner enough architectural information to write tasks. The brainstorming skill mandates that the spec cover architecture, components, data flow, error handling, and testing. Flag the spec when any load-bearing dimension is missing: (a) no component decomposition (the spec states requirements but never names the modules / units / services that will implement them); (b) no data flow description (request shape, response shape, or how data moves between named components is silent); (c) no error-handling treatment for failure modes that the requirements themselves imply (e.g. a "shall validate the token" requirement with no statement of what happens on invalid token); (d) no testing strategy section (silent on unit / integration / contract / manual layer). Severity HIGH when the missing dimension is load-bearing for downstream planning (the planner would have to invent the architecture); MEDIUM when the dimension is partial (named but underspecified). For each finding, name the missing dimension and the section that should contain it. This perspective is the spec-side complement to plan-audit perspective 10 (SPEC-COVERAGE) — together they enforce that the spec gives the planner enough to build, and the plan in turn covers the spec.',
].join('\n');

export const SPEC_AUDIT_CRITERIA: readonly CriterionEntry[] = parseCriteria(SPEC_AUDIT_FAILURE_MODES);

export const SPEC_AUDIT_SEMANTICS: RouteSemantics = {
  goalLine: 'Find ALL ways this spec, executed literally by a downstream worker, would produce the wrong outcome or paralyze the executor — viewed through this criterion.',
  emptyOutcomeLine: 'If THIS criterion does not surface a real gap in the spec, respond with the literal text "No findings for this criterion." — that is a valid outcome on a clean spec.',
  findingMeaningParagraph: 'A finding is a PLACE WHERE THE SPEC PROSE FAILS THE EXECUTABILITY TEST viewed through this criterion. Title = the failing prose snippet (or its anchor). Severity reflects whether the failure would silently ship wrong behavior, block the executor, force a clarification round, or just leave a stylistic gap.',
  severityMeanings: {
    critical: 'literal execution would silently produce the wrong outcome — e.g. a requirement whose stated test would pass on broken behavior, or two requirements that contradict in a way the executor cannot detect.',
    high: 'would block the executor — vague verb without a measurable outcome on a load-bearing requirement, missing acceptance criterion on a critical path, undeclared assumption that downstream code depends on.',
    medium: 'would force a clarification round — implicit scope, decision without trace, non-functional constraint hinted but not stated.',
    low: 'stylistic / metadata gap; minor inconsistency that does not affect executability.',
  },
  mustEmitAtLeastOne: false,
  legalOutcomes: ['found', 'clean'] as const,
};
