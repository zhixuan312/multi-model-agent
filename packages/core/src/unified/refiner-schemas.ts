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

const executePlanAnswerSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1),
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

// Fields shared by every node-writing decision (create/refine/supersede).
const journalNodeFields = {
  title: z.string().min(1),
  type: journalNodeTypeEnum,
  topic: z.string().min(1),
  tags: z.array(z.string().min(1)),
  links: z.array(journalLinkSchema),
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
 * Self-contained fenced-```json``` extraction. No external helper —
 * reviewer-output-parser.ts exports only parseReviewerOutput. Falls back to
 * parsing the whole payload as JSON when no fence is present.
 */
function extractDecisionJson(text: string): unknown {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : text);
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
