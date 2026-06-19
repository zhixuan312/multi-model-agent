import { z } from 'zod';
import type { TaskType } from './type-registry.js';

const severity = z.enum(['critical', 'high', 'medium', 'low']);

export const auditAnswerSchema = z.object({
  findingsCount: z.number().int().min(0),
  criteriaCovered: z.array(z.string().min(1)),
  overallAssessment: z.enum(['found', 'clean']),
  findings: z.array(z.object({
    severity,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    suggestion: z.string().min(1),
  })),
});

export const investigateAnswerSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  citations: z.array(z.object({
    file: z.string().min(1),
    line: z.number().int().min(0).default(0),
    content: z.string().min(1),
  })),
  confidence: z.enum(['high', 'medium', 'low']),
  negativeFindings: z.array(z.string()).default([]),
  subAnswers: z.array(z.object({
    perspective: z.string().min(1),
    finding: z.string().min(1),
    confidence: z.enum(['high', 'medium', 'low']),
  })).default([]),
});

export const reviewAnswerSchema = z.object({
  findingsCount: z.number().int().min(0),
  focusArea: z.string().min(1),
  findings: z.array(z.object({
    severity,
    category: z.string().min(1),
    claim: z.string().min(1),
    evidence: z.string().min(1),
    location: z.string().min(1),
    suggestion: z.string().min(1),
  })),
  preExisting: z.array(z.string()).default([]),
});

export const debugAnswerSchema = z.object({
  reproduction: z.string().min(1),
  symptom: z.object({
    file: z.string().min(1),
    line: z.number().int().min(0).default(0),
    description: z.string().min(1),
  }),
  cause: z.object({
    file: z.string().min(1),
    line: z.number().int().min(0).default(0),
    description: z.string().min(1),
  }),
  trace: z.array(z.object({
    file: z.string().min(1),
    line: z.number().int().min(0).default(0),
    observation: z.string().min(1),
  })),
  proposedFix: z.string().min(1),
  falsifier: z.string().min(1),
  otherDefects: z.array(z.string()).default([]),
});

export const researchAnswerSchema = z.object({
  sources: z.array(z.object({
    title: z.string().min(1),
    url: z.string().min(1),
    attempted: z.boolean(),
    used: z.boolean(),
    note: z.string().optional(),
  })),
  findings: z.array(z.object({
    perspective: z.string().min(1),
    insight: z.string().min(1),
    sourceUrl: z.string().min(1),
    suggestion: z.string().optional(),
  })),
  synthesis: z.string().min(1),
});

export const delegateAnswerSchema = z.object({
  tasksCompleted: z.array(z.string()),
  filesChanged: z.array(z.string()),
  workerSelfAssessment: z.enum(['done', 'failed']),
  notes: z.string(),
});

export const executePlanAnswerSchema = z.object({
  stepsCompleted: z.array(z.string()),
  filesChanged: z.array(z.string()),
  testsPassed: z.boolean(),
  workerSelfAssessment: z.enum(['done', 'failed']),
  reconciliations: z.array(z.string()).default([]),
  notes: z.string(),
});

export const journalRecallAnswerSchema = z.object({
  results: z.array(z.object({
    learning: z.string().min(1),
    context: z.string().min(1),
    relevance: severity,
    nodeId: z.string().min(1),
    nodePath: z.string().min(1),
    category: z.enum(['decision', 'design', 'behavior', 'process', 'knowledge', 'style']),
    status: z.enum(['adopted', 'dropped', 'inconclusive', 'superseded']),
  })),
  summary: z.string().min(1),
});

export const journalRecordAnswerSchema = z.object({
  summary: z.string().min(1),
  filesChanged: z.array(z.string()),
  recorded: z.array(z.object({
    learningIndex: z.number().int().min(0),
    op: z.enum(['create', 'refine', 'supersede', 'merge']),
    ids: z.array(z.string().min(1)),
  })),
  failed: z.array(z.object({
    learningIndex: z.number().int().min(0),
    learning: z.string().min(1),
    reason: z.string().min(1),
  })),
});

export const REFINER_SCHEMAS: Partial<Record<TaskType, z.ZodType>> = {
  audit: auditAnswerSchema,
  investigate: investigateAnswerSchema,
  review: reviewAnswerSchema,
  debug: debugAnswerSchema,
  research: researchAnswerSchema,
  delegate: delegateAnswerSchema,
  execute_plan: executePlanAnswerSchema,
  journal_recall: journalRecallAnswerSchema,
  journal_record: journalRecordAnswerSchema,
};
