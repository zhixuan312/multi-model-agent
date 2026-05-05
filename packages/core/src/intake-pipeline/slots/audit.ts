import type { BriefSlotFiller } from '../brief-compiler.js';

export interface AuditInput {
  documentPaths: string[];
  questionnaire?: string;
  cwd?: string;
}

export interface AuditBrief {
  taskIndex: number;
  brief: string;
  cwd: string;
  agentType: 'complex';
  reviewPolicy: 'quality_only';
  contextBlockIds: string[];
  documentPath: string;
}

export const auditSlot: BriefSlotFiller<AuditInput, AuditBrief[]> = (input) => {
  return input.documentPaths.map((p, i) => ({
    taskIndex: i,
    brief: `Audit ${p} against the following questionnaire:\n${input.questionnaire ?? '(default audit checklist)'}`,
    cwd: input.cwd ?? process.cwd(),
    agentType: 'complex',
    reviewPolicy: 'quality_only',
    contextBlockIds: [],
    documentPath: p,
  }));
};
