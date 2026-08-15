import { z } from 'zod';
import type { TaskType } from './type-registry.js';
import type { ApplyRecordInput } from '../journal/index.js';

const severityEnum = z.enum(['critical', 'high', 'medium', 'low']);

// --- Read route schemas (criteriaCovered + findings) ---

const auditAnswerSchema = z.object({
  criteriaCovered: z.array(z.string().min(1)),
  findings: z.array(z.object({
    weight: severityEnum,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    suggestion: z.string(),
  })),
});

const investigateAnswerSchema = z.object({
  answer: z.string().min(1),
  criteriaCovered: z.array(z.string().min(1)),
  findings: z.array(z.object({
    weight: severityEnum,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    file: z.string().min(1),
    line: z.number().int().nonnegative().default(0),
  })),
});

const reviewAnswerSchema = z.object({
  criteriaCovered: z.array(z.string().min(1)),
  findings: z.array(z.object({
    weight: severityEnum,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    file: z.string().min(1),
    line: z.number().int().nonnegative().default(0),
    suggestion: z.string(),
    preExisting: z.boolean().default(false),
  })),
});

const debugAnswerSchema = z.object({
  answer: z.string().min(1),
  criteriaCovered: z.array(z.string().min(1)),
  findings: z.array(z.object({
    weight: severityEnum,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    file: z.string().nullable().default(null),
    line: z.number().int().nonnegative().nullable().default(null),
  })),
});

const researchAnswerSchema = z.object({
  answer: z.string().min(1),
  criteriaCovered: z.array(z.string().min(1)),
  findings: z.array(z.object({
    weight: severityEnum,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    url: z.string(),
    source: z.string().min(1),
  })),
});

const journalRecallAnswerSchema = z.object({
  answer: z.string().min(1),
  criteriaCovered: z.array(z.string().min(1)),
  findings: z.array(z.object({
    weight: severityEnum,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    topic: z.string().min(1),
    fallback: z.boolean(),
    nodeId: z.string().min(1),
    nodePath: z.string().min(1),
  })),
});

// --- Write route schemas (per-item status) ---

const delegateAnswerSchema = z.object({
  status: z.enum(['done', 'failed']),
  notes: z.string(),
});

// `id` is the authoritative key the contract matches on; `title` is optional display prose the
// reviewer may paraphrase freely. Requiring a verbatim title here is what made a reworded echo
// indistinguishable from unfinished work.
const executePlanAnswerSchema = z.object({
  tasks: z.array(z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    status: z.enum(['done', 'failed']),
  })),
  notes: z.string().default(''),
});

const journalRecordAnswerSchema = z.object({
  recorded: z.array(z.object({
    learning: z.string().min(1),
    type: z.string().min(1),
    topic: z.string().min(1),
    nodeId: z.string().min(1),
    nodePath: z.string().min(1),
  })),
  failed: z.array(z.object({
    learning: z.string().min(1),
    reason: z.string().min(1),
  })).default([]),
});

const specAnswerSchema = z.object({
  specPath: z.string().min(1),
  sections: z.array(z.string().min(1)),
  acceptanceCriteriaCount: z.number().int().nonnegative(),
  notes: z.string().default(''),
});

const planAnswerSchema = z.object({
  planPath: z.string().min(1),
  taskCount: z.number().int().nonnegative(),
  tasks: z.array(z.object({
    title: z.string().min(1),
    verdict: z.enum(['executable', 'partial', 'blocked']),
    // Optional contract-first signal: whether the plan task's Contract + acceptance tests are
    // complete. Absence is a SIGNAL, not legacy tolerance — plan/review.md tells the reviewer to
    // set this only when its pass directly evidences one, so omitting it means "no evidence either
    // way". Reading it as legacy would invite deleting the optionality, which this repo's
    // no-backward-compatibility rule would otherwise justify.
    //
    // This shape was ALSO declared by hand as a `PlanTaskReviewRecord` interface in
    // reviewer-output-parser.ts, exported and consumed by nothing — two declarations of one shape,
    // only one of which validates anything. Deleted; this schema is the single source.
    contractCompleteness: z.enum(['complete', 'incomplete']).optional(),
  })),
  notes: z.string().default(''),
});

// --- Journal record DECISION schema (implementer output, decide-then-apply) ---
// This is the shape the journal_record IMPLEMENTER emits: an array of
// { learning, decision } — which IS the ApplyRecordInput[] shape consumed by
// JournalStore.applyRecordBatch (see journal/store.ts). It is NOT a final answer
// schema; the reviewer/refiner still emits the { recorded, failed } answer above.

const journalNodeTypeEnum = z.enum(['decision', 'design', 'behavior', 'process', 'knowledge', 'style']);
const journalStatusEnum = z.enum(['adopted', 'dropped', 'inconclusive', 'superseded']);
const journalLinkTypeEnum = z.enum(['supersedes', 'refines', 'relates', 'depends-on', 'contradicts', 'parent']);
const journalLinkSchema = z.object({ type: journalLinkTypeEnum, target: z.string().min(1) });
const VALID_LINK_TYPES: readonly string[] = journalLinkTypeEnum.options;

// LENIENT extra-links sanitizer. This is a decide-then-apply system: the implementer LLM
// sometimes emits over-eager or placeholder edges — a link with a `type` but no `target`,
// the legacy `to:` spelling, or an invented edge type. Rejecting the WHOLE record for one
// stray edge (the original dogfood bug) is wrong; the deterministic layer should sanitize
// the decision, not throw it away. So we: (a) accept `to` as an alias for `target`
// (mirrors the node-codec read-side), (b) DROP any entry lacking a non-empty string target,
// and (c) DROP any entry whose type is not one of the 6 valid edge types. A missing `links`
// field sanitizes to []. The REQUIRED refine/supersede relationship stays strict — it lives
// in top-level `targetNodeId`, which the discriminated union below still hard-requires.
const sanitizedLinksSchema = z.preprocess((raw) => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const link = entry as Record<string, unknown>;
    const target = link.target ?? link.to;
    if (typeof link.type !== 'string' || !VALID_LINK_TYPES.includes(link.type)) return [];
    if (typeof target !== 'string' || target.trim() === '') return [];
    return [{ type: link.type, target }];
  });
}, z.array(journalLinkSchema));

// Fields shared by every node-writing decision (create/refine/supersede).
const journalNodeFields = {
  title: z.string().min(1),
  type: journalNodeTypeEnum,
  topic: z.string().min(1),
  tags: z.array(z.string().min(1)),
  links: sanitizedLinksSchema,
  status: journalStatusEnum,
  description: z.string().min(1),
  context: z.string().min(1),
  consequences: z.string().min(1),
} as const;

// A discriminated union on `kind` so the implicit contract is enforced at parse
// time: `create` needs NO target, while `refine`/`supersede` REQUIRE a
// `targetNodeId` (the node they relate to / replace). A `refine`/`supersede`
// with no target is rejected here instead of silently applying like a plain
// create and dropping the relationship.
const journalRecordDecisionSchema = z.array(z.object({
  learning: z.string().min(1),
  decision: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), ...journalNodeFields }),
    z.object({ kind: z.literal('refine'), targetNodeId: z.string().min(1), ...journalNodeFields }),
    z.object({ kind: z.literal('supersede'), targetNodeId: z.string().min(1), ...journalNodeFields }),
    z.object({
      kind: z.literal('merge'),
      targetNodeId: z.string().min(1),
      reason: z.string().min(1),
    }),
  ]),
}));

/**
 * Fenced-```json``` extraction for the decision payload — the LAST block, never the first.
 *
 * This took the FIRST fenced block, which is the exact defect `reviewer-output-parser`'s own
 * extractor was fixed for and records in the changelog: "Last-JSON-block extraction prevents LLM
 * preamble from corrupting parsed output". The fix reached one copy of the idea and not this one.
 *
 * The consequence here is worse than a corrupted answer. An implementer that shows its reasoning
 * as a draft block and then emits the final one had its DRAFT parsed — and these decisions are
 * applied deterministically to the journal graph, so the wrong nodes were created, refined, or
 * superseded with nothing reporting a problem.
 *
 * Deliberately NOT sharing `reviewer-output-parser`'s extractor despite the overlap: its
 * no-fence fallback matches a bare `{…}` OBJECT, while a decision payload is a top-level ARRAY.
 * Sharing it would silently extract a fragment from the first `{` to the last `}`. Same lesson,
 * different payload shape — so the lesson is copied, not the code.
 */
function extractDecisionJson(text: string): unknown {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  return JSON.parse(fenced.length > 0 ? fenced[fenced.length - 1]![1]! : text);
}

/**
 * Parse + validate the implementer's decision output into ApplyRecordInput[].
 * Throws on malformed JSON or schema mismatch — the route maps that throw to
 * "all records failed".
 */
export function parseRecordDecisions(implementerOutput: string): ApplyRecordInput[] {
  return journalRecordDecisionSchema.parse(extractDecisionJson(implementerOutput)) as ApplyRecordInput[];
}

export const REFINER_SCHEMAS: Partial<Record<TaskType | 'journal_record_decision', z.ZodType>> = {
  audit: auditAnswerSchema,
  investigate: investigateAnswerSchema,
  review: reviewAnswerSchema,
  debug: debugAnswerSchema,
  research: researchAnswerSchema,
  journal_recall: journalRecallAnswerSchema,
  delegate: delegateAnswerSchema,
  execute_plan: executePlanAnswerSchema,
  journal_record: journalRecordAnswerSchema,
  journal_record_decision: journalRecordDecisionSchema,
  spec: specAnswerSchema,
  plan: planAnswerSchema,
};
