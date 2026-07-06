import { z } from 'zod';
import type { TaskType } from './type-registry.js';

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
    nodeId: z.string().min(1),
    nodePath: z.string().min(1),
  })),
  failed: z.array(z.object({
    learning: z.string().min(1),
    reason: z.string().min(1),
  })).default([]),
});

export const REFINER_SCHEMAS: Partial<Record<TaskType, z.ZodType>> = {
  audit: auditAnswerSchema,
  investigate: investigateAnswerSchema,
  review: reviewAnswerSchema,
  debug: debugAnswerSchema,
  research: researchAnswerSchema,
  journal_recall: journalRecallAnswerSchema,
  delegate: delegateAnswerSchema,
  execute_plan: executePlanAnswerSchema,
  journal_record: journalRecordAnswerSchema,
};
