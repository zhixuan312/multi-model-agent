// Audit subtypes — per-subtype prompt-policy packages keyed by AuditSubtype.
// Adding a new audit subtype = one new entry here + one enum literal in schema.ts.
import type { ReadOnlySubtypeSpec } from '../../lifecycle/read-only-subtype-spec.js';
import type { RouteSemantics } from '../parallel-criteria-prompt.js';
import {
  AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_AUDIT, SCOPE_RULE_AUDIT,
  ANNOTATOR_AWARENESS_AUDIT, AUDIT_CRITERIA,
} from './implementer-criteria.js';
import {
  PLAN_AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_PLAN_AUDIT, SCOPE_RULE_PLAN_AUDIT,
  ANNOTATOR_AWARENESS_PLAN_AUDIT, PLAN_AUDIT_CRITERIA,
} from './plan-audit-criteria.js';
import { SPEC_AUDIT_CRITERIA, SPEC_AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_SPEC_AUDIT, SCOPE_RULE_SPEC_AUDIT, ANNOTATOR_AWARENESS_SPEC_AUDIT, SPEC_AUDIT_SEMANTICS } from './spec-audit-criteria.js';
import { SKILL_AUDIT_CRITERIA, SKILL_AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_SKILL_AUDIT, SCOPE_RULE_SKILL_AUDIT, ANNOTATOR_AWARENESS_SKILL_AUDIT, SKILL_AUDIT_SEMANTICS } from './skill-audit-criteria.js';

export type AuditSubtype = 'default' | 'plan' | 'spec' | 'skill';

// Copied verbatim from ROUTE_SEMANTICS.audit in
// packages/core/src/lifecycle/parallel-criteria-routes.ts (the legacy
// private const there is removed in Task 8 once dispatch reads from here).
const SEMANTICS_DEFAULT: RouteSemantics = {
  goalLine: 'Find ALL issues of THIS specific kind in the artifact above.',
  emptyOutcomeLine: 'If none exist, respond with the literal text "No findings for this criterion." — that is a fully valid outcome. Do NOT pad with low-signal observations to avoid returning empty.',
  findingMeaningParagraph: 'A finding is an ISSUE in the artifact (a contradiction, missing recommendation, fix that violates a constraint, drift, structural inconsistency, etc.). Severity reflects how much the issue blocks the artifact\'s downstream use.',
  severityMeanings: {
    critical: 'a recommendation or claim that, if implemented as written, would fail or cause harm because the artifact is internally incoherent — e.g. a fix that depends on something the doc forbids.',
    high: 'a substantive missing recommendation, an evidence chain that does not support a load-bearing conclusion, OR a fix that violates a stated principle/constraint of the doc.',
    medium: 'argument-soundness gap, fix-actionability gap, drift between sections, structural inconsistency between similar items, scope-creep risk that needs a guardrail.',
    low: 'stylistic / labeling / formatting issue; missing metadata; minor cross-reference fix.',
  },
  mustEmitAtLeastOne: false,
};

// Copied verbatim from ROUTE_SEMANTICS.audit_plan.
const SEMANTICS_PLAN: RouteSemantics = {
  goalLine: 'Apply THIS verification perspective to every task in the plan above. Each finding is a plan-vs-codebase coherence issue grounded in real file:line evidence. Verify before flagging — use read_file / grep to inspect the source files the plan names.',
  emptyOutcomeLine: 'If your perspective finds no plan-vs-codebase drift after grounding in the actual source files, respond with the literal text "No findings for this criterion." — that is the EXPECTED outcome on a clean plan. Do NOT pad with prose-quality observations (those belong in subtype=default, not here).',
  findingMeaningParagraph: 'A finding is a CONCRETE PLAN-VS-CODEBASE DRIFT viewed through this perspective: the plan names a symbol / path / signature / import / test helper / verify command / cross-task dependency that the actual codebase does not match. Title = "<task ID>: <one-line drift>". Severity reflects whether the task can dispatch.',
  severityMeanings: {
    critical: 'plan would BLOCK dispatch — e.g. wrong method name (perspective 2), missing modify-target file (perspective 1), wrong signature (perspective 3), missing module export (perspective 4), out-of-order task dependency (perspective 7), wrong tooling (perspective 8). A literal worker freezes on this.',
    high: 'load-bearing ambiguity — multiple matching symbols and the plan does not disambiguate, OR test harness missing in claimed shape, OR step depends on later step recoverably. Task may execute but produces an ambiguous artifact.',
    medium: 'step ordering inferable but undeclared, cross-task dependency unstated, verify command vague but recoverable, missing parent dirs for create-targets. Fixable by reordering or adding a sentence; doesn\'t block dispatch.',
    low: 'cosmetic — naming preference, missing metadata, minor cross-reference. Does not affect executability.',
  },
  mustEmitAtLeastOne: false,
};

export const AUDIT_SUBTYPES: Record<AuditSubtype, ReadOnlySubtypeSpec> = {
  default: {
    criteria: AUDIT_CRITERIA,
    orientation: AUDIT_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_AUDIT,
    scopeRule: SCOPE_RULE_AUDIT,
    annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
    semantics: SEMANTICS_DEFAULT,
  },
  plan: {
    criteria: PLAN_AUDIT_CRITERIA,
    orientation: PLAN_AUDIT_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_PLAN_AUDIT,
    scopeRule: SCOPE_RULE_PLAN_AUDIT,
    annotatorAwareness: ANNOTATOR_AWARENESS_PLAN_AUDIT,
    semantics: SEMANTICS_PLAN,
  },
  spec: {
    criteria: SPEC_AUDIT_CRITERIA,
    orientation: SPEC_AUDIT_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_SPEC_AUDIT,
    scopeRule: SCOPE_RULE_SPEC_AUDIT,
    annotatorAwareness: ANNOTATOR_AWARENESS_SPEC_AUDIT,
    semantics: SPEC_AUDIT_SEMANTICS,
  },
  skill: {
    criteria: SKILL_AUDIT_CRITERIA,
    orientation: SKILL_AUDIT_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_SKILL_AUDIT,
    scopeRule: SCOPE_RULE_SKILL_AUDIT,
    annotatorAwareness: ANNOTATOR_AWARENESS_SKILL_AUDIT,
    semantics: SKILL_AUDIT_SEMANTICS,
  },
};
