import type { CriterionEntry } from '../tools/criteria-types.js';
import {
  buildReadOnlyCachedPrefix,
  buildReadOnlyCriterionSuffix,
  type CachedPrefixTarget,
  type CachedPrefixBlocks,
  type RouteSemantics,
} from '../tools/parallel-criteria-prompt.js';
import {
  AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_AUDIT, SCOPE_RULE_AUDIT, ANNOTATOR_AWARENESS_AUDIT, AUDIT_CRITERIA,
} from '../tools/audit/implementer-criteria.js';
import {
  PLAN_AUDIT_PURPOSE_ORIENTATION, EVIDENCE_RULE_PLAN_AUDIT, SCOPE_RULE_PLAN_AUDIT, ANNOTATOR_AWARENESS_PLAN_AUDIT, PLAN_AUDIT_CRITERIA,
} from '../tools/audit/plan-audit-criteria.js';
import {
  REVIEW_PURPOSE_ORIENTATION, EVIDENCE_RULE_REVIEW, SCOPE_RULE_REVIEW, ANNOTATOR_AWARENESS_REVIEW, REVIEW_CRITERIA,
} from '../tools/review/implementer-criteria.js';
import {
  DEBUG_PURPOSE_ORIENTATION, EVIDENCE_RULE_DEBUG, SCOPE_RULE_DEBUG, ANNOTATOR_AWARENESS_DEBUG, DEBUG_CRITERIA,
} from '../tools/debug/implementer-criteria.js';
import {
  INVESTIGATE_PURPOSE_ORIENTATION, EVIDENCE_RULE_INVESTIGATE, SCOPE_RULE_INVESTIGATE, ANNOTATOR_AWARENESS_INVESTIGATE, INVESTIGATE_CRITERIA,
} from '../tools/investigate/implementer-criteria.js';

export type ReadOnlyRouteName = 'audit' | 'audit_plan' | 'review' | 'debug' | 'investigate';

/** Standard finding-format spec — uniform `## Finding N:` shape across
 *  all five read-only routes so the downstream parser/annotator only
 *  reads one format. The label "Issue" is intentionally route-neutral
 *  (interpreted as issue / candidate-answer / verdict / root-cause-
 *  hypothesis depending on the route's semantics block). */
const FINDING_FORMAT_SHARED = [
  'Per-finding output format (use exactly this shape — `## Finding N:` blocks):',
  '',
  '## Finding 1: <one-line title>',
  '- Severity: critical | high | medium | low',
  '- Location: file:line (when applicable)',
  '- Issue: one-paragraph explanation (the issue OR the candidate-answer OR the verification verdict OR the root-cause hypothesis, per this route\'s "what a finding means")',
  '- Suggestion: one-line follow-up (a fix / how to verify / where to look next)',
  '',
  '## Finding 2: ... (one block per finding)',
  '',
  'Number findings sequentially starting at 1. Severity / Location / Issue / Suggestion bullets are on their own lines with the labels exactly as shown.',
].join('\n');

/** Per-route semantics. Findings shape and severity tiers are uniform;
 *  only the *meaning* of each tier and the per-sub-worker goal differ. */
const ROUTE_SEMANTICS: Record<ReadOnlyRouteName, RouteSemantics> = {
  audit: {
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
  },
  audit_plan: {
    goalLine: 'Apply THIS verification perspective to every task in the plan above. Each finding is a plan-vs-codebase coherence issue grounded in real file:line evidence. Verify before flagging — use read_file / grep to inspect the source files the plan names.',
    emptyOutcomeLine: 'If your perspective finds no plan-vs-codebase drift after grounding in the actual source files, respond with the literal text "No findings for this criterion." — that is the EXPECTED outcome on a clean plan. Do NOT pad with prose-quality observations (those belong in auditType=default, not here).',
    findingMeaningParagraph: 'A finding is a CONCRETE PLAN-VS-CODEBASE DRIFT viewed through this perspective: the plan names a symbol / path / signature / import / test helper / verify command / cross-task dependency that the actual codebase does not match. Title = "<task ID>: <one-line drift>". Severity reflects whether the task can dispatch.',
    severityMeanings: {
      critical: 'plan would BLOCK dispatch — e.g. wrong method name (perspective 2), missing modify-target file (perspective 1), wrong signature (perspective 3), missing module export (perspective 4), out-of-order task dependency (perspective 7), wrong tooling (perspective 8). A literal worker freezes on this.',
      high: 'load-bearing ambiguity — multiple matching symbols and the plan does not disambiguate, OR test harness missing in claimed shape, OR step depends on later step recoverably. Task may execute but produces an ambiguous artifact.',
      medium: 'step ordering inferable but undeclared, cross-task dependency unstated, verify command vague but recoverable, missing parent dirs for create-targets. Fixable by reordering or adding a sentence; doesn\'t block dispatch.',
      low: 'cosmetic — naming preference, missing metadata, minor cross-reference. Does not affect executability.',
    },
    mustEmitAtLeastOne: false,
  },
  review: {
    goalLine: 'Find ALL issues of THIS specific kind in the diff / source above.',
    emptyOutcomeLine: 'If none exist, respond with the literal text "No findings for this criterion." — that is a fully valid outcome. Do NOT pad to avoid returning empty.',
    findingMeaningParagraph: 'A finding is an ISSUE introduced or worsened by the change under review (correctness bug, missing test, race, security regression, contract break, etc.). Severity reflects how much the issue blocks merge / ships a regression.',
    severityMeanings: {
      critical: 'security regression / data corruption / build-breaking change — must NOT merge.',
      high: 'real correctness bug, broken tests, race, missing edge case that ships a regression — blocks release.',
      medium: 'contract violation, maintainability issue, doc gap, deprecated API, performance regression on a non-hot path — fix soon, not blocking.',
      low: 'style, naming, comment nit, dead code — nice-to-fix.',
    },
    mustEmitAtLeastOne: false,
  },
  debug: {
    goalLine: 'Apply THIS failure mode as the lens. Each finding is a root-cause hypothesis (or contributing factor), framed against this lens; severity = strength of the evidence chain.',
    emptyOutcomeLine: 'If THIS lens reveals nothing in the failure under investigation, respond with "No findings for this criterion." — valid outcome.',
    findingMeaningParagraph: 'A finding is a ROOT-CAUSE HYPOTHESIS (or contributing factor) for the failure under investigation, viewed through this criterion\'s lens. Title = the proposed cause. Severity reflects how strong the trace from symptom to cause is.',
    severityMeanings: {
      critical: 'root cause definitively identified with reproducible evidence + a concrete fix is implied — the maintainer can act now.',
      high: 'strong root-cause hypothesis with traced upstream evidence (file:line citations along the call/data path), fix path identified.',
      medium: 'likely candidate cause, needs verification — the trace has 1-2 inferred steps, fix scope unclear.',
      low: 'possible contributing factor, low confidence — speculation worth noting but not the primary lead.',
    },
    mustEmitAtLeastOne: true,
  },
  investigate: {
    goalLine: 'Answer the user\'s question above. Each finding is a CANDIDATE ANSWER (or sub-answer / partial answer) to the question, presented through this criterion\'s lens. Pay extra care to AVOID this criterion\'s failure mode (it is a known way investigators go wrong on questions like this).',
    emptyOutcomeLine: 'If you can produce no candidate answer at all under this lens, respond with "No findings for this criterion." — valid but rare outcome. In most cases you can produce at least one low-confidence candidate answer.',
    findingMeaningParagraph: 'A finding is a CANDIDATE ANSWER to the user\'s question (or a sub-answer that contributes to the full answer). Title = the answer in one line. Issue = the answer with reasoning + citations. Severity = your confidence in this answer.',
    severityMeanings: {
      critical: 'THE answer — high-confidence, multiple grounded file:line citations, evidence chain has no inferred steps. The user can act on this without re-verification.',
      high: 'strong answer — fully grounded with file:line citations, evidence chain has at most one inferred step, single-source. The user should sanity-check the inferred step.',
      medium: 'likely answer / partial answer — inference from evidence, some gaps in chain. Mark "verify by reading <file>" so the user knows where to confirm.',
      low: 'possible answer / candidate — weak evidence, presented as an alternative for the user to consider against other sub-workers\' candidates.',
    },
    mustEmitAtLeastOne: true,
  },
};

const ROUTE_BLOCKS: Record<ReadOnlyRouteName, Omit<CachedPrefixBlocks, 'findingFormat' | 'semantics'>> = {
  audit: {
    orientation: AUDIT_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_AUDIT,
    scopeRule: SCOPE_RULE_AUDIT,
    annotatorAwareness: ANNOTATOR_AWARENESS_AUDIT,
    criteria: AUDIT_CRITERIA,
  },
  audit_plan: {
    orientation: PLAN_AUDIT_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_PLAN_AUDIT,
    scopeRule: SCOPE_RULE_PLAN_AUDIT,
    annotatorAwareness: ANNOTATOR_AWARENESS_PLAN_AUDIT,
    criteria: PLAN_AUDIT_CRITERIA,
  },
  review: {
    orientation: REVIEW_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_REVIEW,
    scopeRule: SCOPE_RULE_REVIEW,
    annotatorAwareness: ANNOTATOR_AWARENESS_REVIEW,
    criteria: REVIEW_CRITERIA,
  },
  debug: {
    orientation: DEBUG_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_DEBUG,
    scopeRule: SCOPE_RULE_DEBUG,
    annotatorAwareness: ANNOTATOR_AWARENESS_DEBUG,
    criteria: DEBUG_CRITERIA,
  },
  investigate: {
    orientation: INVESTIGATE_PURPOSE_ORIENTATION,
    evidenceRule: EVIDENCE_RULE_INVESTIGATE,
    scopeRule: SCOPE_RULE_INVESTIGATE,
    annotatorAwareness: ANNOTATOR_AWARENESS_INVESTIGATE,
    criteria: INVESTIGATE_CRITERIA,
  },
};

export interface ReadOnlyRouteSpec {
  criteria: readonly CriterionEntry[];
  buildPrefix: (target: CachedPrefixTarget) => string;
  buildSuffix: (criterion: CriterionEntry) => string;
}

/**
 * Per-route configuration consumed by the parallel-criteria dispatcher.
 * Each entry returns the full builders so the orchestrator can fan out
 * without route-specific branching code.
 */
export const READ_ONLY_ROUTES: Record<ReadOnlyRouteName, ReadOnlyRouteSpec> = Object.fromEntries(
  (['audit', 'audit_plan', 'review', 'debug', 'investigate'] as const).map((route) => {
    const semantics = ROUTE_SEMANTICS[route];
    const blocks: CachedPrefixBlocks = {
      ...ROUTE_BLOCKS[route],
      findingFormat: FINDING_FORMAT_SHARED,
      semantics,
    };
    return [route, {
      criteria: ROUTE_BLOCKS[route].criteria,
      buildPrefix: (target: CachedPrefixTarget) => buildReadOnlyCachedPrefix(blocks, target),
      buildSuffix: (criterion: CriterionEntry) => buildReadOnlyCriterionSuffix(semantics, criterion),
    }];
  }),
) as Record<ReadOnlyRouteName, ReadOnlyRouteSpec>;

export function isReadOnlyRoute(route: string): route is ReadOnlyRouteName {
  return route in READ_ONLY_ROUTES;
}
