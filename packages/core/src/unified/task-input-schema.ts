import { z } from 'zod';
import { SPEC_COMPONENTS } from './spec-components.js';
import { approvedContractSchema } from './deliverable-contract.js';

const agentTierSchema = z.enum(['standard', 'complex', 'main']);
const reviewPolicySchema = z.enum(['reviewed', 'none']);
const topicSchema = z.string().min(1).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sessionIdsSchema = z.object({
  implementer: z.string().optional(),
  reviewer: z.string().optional(),
}).optional();

const targetSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).optional(),
  inline: z.string().min(1).optional(),
}).refine(
  (t) => {
    const hasPaths = t.paths !== undefined && t.paths.length > 0;
    const hasInline = t.inline !== undefined;
    // Exactly one — reject both-present AND neither-present (an empty target is a
    // subject-less task). Matches the "exactly one of paths or inline" contract
    // documented in the mma-audit/review/spec/plan SKILL.md files.
    return hasPaths !== hasInline;
  },
  { message: 'target must have exactly one of paths or inline' },
);

/**
 * `initiative` — optional linkage from a bounded Execution to a durable Initiative (SPEC-003
 * Task I-6). `task_uuid` is itself OPTIONAL (frozen interface, AC-1.1): when present,
 * `ExecutionRuntime.submit()` resolves the selected Initiative and Task, checks Task membership
 * and Task state (`open | claimed` only), checks claim ownership for a claimed Task, and
 * performs the Task's `open|claimed -> in_progress` transition — all BEFORE any execution handle
 * (`ExecutionRegistry.register` / `ExecutionStore.admit`) or provider session exists. When
 * `task_uuid` is omitted, this is Initiative-only linkage: only the Initiative selector is
 * validated, no Task exists to check membership/state/ownership against, and no Task transition
 * runs. Available on every task type: linked admission is a general execution-dispatch
 * capability, not one route's concern. Mirrors `ExecutionLinkage` in
 * `packages/server/src/application/execution-store.ts` and the outbox's own
 * `linkagePayloadSchema` in `packages/server/src/application/initiative-linker.ts` — kept as an
 * independent literal here (not imported) because this is the wire boundary those two internal
 * shapes are validated against, not the other way around.
 */
const initiativeLinkageSchema = z.object({
  initiative: z.union([
    z.object({ uuid: z.string().uuid() }).strict(),
    z.object({ human_key: z.string().min(1) }).strict(),
  ]),
  task_uuid: z.string().uuid().optional(),
  authorized_by: z.string().min(1),
}).strict();

const commonFields = {
  agentTier: agentTierSchema.optional(),
  reviewPolicy: reviewPolicySchema.optional(),
  sessionIds: sessionIdsSchema,
  contextBlockIds: z.array(z.string()).max(2).optional(),
  initiative: initiativeLinkageSchema.optional(),
};

/**
 * `deliverable` — the optional approved Deliverable Contract, wired only onto `spec`,
 * `plan`, `execute_plan`, and `review` (the SDLC routes a contract governs). Every other
 * task type omits this field entirely, so it cannot appear on their input.
 *
 * `approvedContractSchema` requires `state: 'approved'` and a digest-matched
 * `contractApproval` (INV-7) — a non-approved state or a digest mismatch is rejected here,
 * at the Zod layer, with a field-specific issue under `deliverable`. What this schema
 * cannot check — realpath containment of artifact/command paths and git-repo disposition
 * feasibility — needs the filesystem and the task cwd, so it is validated at the server
 * boundary (`packages/server/src/application/deliverable-contract-validator.ts`) after this
 * schema passes. Omitting `deliverable` stays valid: an unmanaged direct call carries none.
 */
const deliverableField = {
  deliverable: approvedContractSchema.optional(),
};

/**
 * `practice` — the optional technique selector, wired only onto `plan`, `execute_plan`,
 * `review`, and `debug`. It picks HOW to do the work (currently only the retained
 * `'software'` code technique); it does not classify WHAT the deliverable is. `audit`
 * keeps its own `subtype` field (which criteria set examines the artifact) — the two
 * fields mean different things and neither is renamed into the other. Omitting
 * `practice` loads the generic, deliverable-neutral implementer.
 */
const practiceField = {
  practice: z.literal('software').optional(),
};

const journalRecordEntrySchema = z.object({
  prompt: z.string().min(1),
  topic: topicSchema.optional(),
}).strict();

const canonicalJournalRecordSchema = z.object({
  type: z.literal('journal_record'),
  records: z.array(journalRecordEntrySchema).min(1).max(20),
  ...commonFields,
}).strict();

const LEGACY_JOURNAL_RECORD_KEYS = new Set([
  'type',
  'prompt',
  'topic',
  'agentTier',
  'reviewPolicy',
  'sessionIds',
  'contextBlockIds',
]);

/** Boundary normalization: a legacy single-record `journal_record` body
 *  ({ prompt, topic? }) is rewritten to the canonical `{ records: [{ prompt, topic? }] }`
 *  shape so all downstream code sees exactly one representation. Only applies when
 *  `records` is ABSENT and only legacy keys are present — a body carrying both `records`
 *  and a top-level `prompt`/`topic` is left unchanged so the strict canonical schema
 *  rejects the ambiguous mixed shape (FR-12 / AC-1.9). */
function normalizeLegacyJournalRecordInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (value.type !== 'journal_record') return input;
  if ('records' in value) return input;
  if (typeof value.prompt !== 'string') return input;
  if (Object.keys(value).some((key) => !LEGACY_JOURNAL_RECORD_KEYS.has(key))) return input;

  return {
    type: 'journal_record',
    records: [
      {
        prompt: value.prompt,
        ...(value.topic !== undefined ? { topic: value.topic } : {}),
      },
    ],
    ...(value.agentTier !== undefined ? { agentTier: value.agentTier } : {}),
    ...(value.reviewPolicy !== undefined ? { reviewPolicy: value.reviewPolicy } : {}),
    ...(value.sessionIds !== undefined ? { sessionIds: value.sessionIds } : {}),
    ...(value.contextBlockIds !== undefined ? { contextBlockIds: value.contextBlockIds } : {}),
  };
}

export const taskInputSchema = z.preprocess(normalizeLegacyJournalRecordInput, z.discriminatedUnion('type', [
  // Read routes with target
  z.object({
    type: z.literal('audit'),
    subtype: z.enum(['default', 'plan', 'spec', 'skill']).optional(),
    prompt: z.string().optional(),
    target: targetSchema,
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('investigate'),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('review'),
    prompt: z.string().optional(),
    target: targetSchema,
    ...deliverableField,
    ...practiceField,
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('debug'),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    ...practiceField,
    ...commonFields,
  }).strict(),

  // Read routes without target
  z.object({
    type: z.literal('research'),
    prompt: z.string().min(20),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('journal_recall'),
    prompt: z.string().min(10),
    topic: topicSchema.optional(),
    includeHistory: z.boolean().optional().default(false),
    ...commonFields,
  }).strict(),

  // Write routes
  z.object({
    type: z.literal('delegate'),
    prompt: z.string().min(1),
    target: z.object({ paths: z.array(z.string().min(1)).min(1) }).optional(),
    done: z.string().optional(),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('execute_plan'),
    prompt: z.string().optional(),
    target: z.object({ paths: z.array(z.string().min(1)).length(1) }),
    tasks: z.array(z.string()).default([]),
    ...deliverableField,
    ...practiceField,
    ...commonFields,
  }).strict(),

  canonicalJournalRecordSchema,

  z.object({
    type: z.literal('orchestrate'),
    prompt: z.string().min(1),
    outputFormat: z.string().optional(),
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('spec'),
    prompt: z.string().min(1),
    target: targetSchema,
    outputPath: z.string().optional(),
    components: z.array(z.enum(SPEC_COMPONENTS)).optional(),
    ...deliverableField,
    ...commonFields,
  }).strict(),

  z.object({
    type: z.literal('plan'),
    prompt: z.string().min(1),
    target: targetSchema,
    outputPath: z.string().optional(),
    ...deliverableField,
    ...practiceField,
    ...commonFields,
  }).strict(),
]));

export type TaskInput = z.infer<typeof taskInputSchema>;
