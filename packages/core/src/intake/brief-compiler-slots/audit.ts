import type { DraftTask, AuditSource } from '../types.js';
import { createDraftId, escapeFanoutKey, canonicalizePath } from '../draft-id.js';

export interface AuditDocumentInput {
  document?: string;
  filePaths?: string[];
  auditType?: string;
}

const SCOPE_CONTRACT = `
Audit this document for the requested dimension. To verify specific factual claims, read the exact files referenced by the document. Do NOT enumerate the repository; do NOT glob across all source files. If a claim references a file path or function name, read or grep for that specific name. Stay scoped: the goal is to evaluate the document, not catalog the codebase.
`.trim();

export function compileAuditDocument(
  input: AuditDocumentInput,
  requestId: string,
): DraftTask[] {
  const filePaths = input.filePaths ?? [];

  if (filePaths.length <= 1) {
    const promptParts: string[] = [];
    if (input.document) promptParts.push(`Document to audit:\n${input.document}`);
    if (input.auditType) promptParts.push(`Audit type: ${input.auditType}`);
    if (filePaths.length) promptParts.push(`\nFiles to audit: ${filePaths.join(', ')}`);
    promptParts.push(
      'You MUST re-read all target files before comparing against prior findings. Do not audit from the context block alone — the context block contains the prior round\'s findings, not the current file contents.',
      '',
      'Produce a narrative audit report. Number each finding (1, 2, 3, ...). For each finding, on its own line, state:',
      '  Severity: critical | high | medium | low',
      '  Location: file:line (when applicable)',
      '  Issue: one-paragraph explanation',
      '  Suggestion: one-line fix recommendation',
      'The reviewer will extract structured findings from your report — do NOT emit JSON.',
      '',
      SCOPE_CONTRACT,
    );

    return [{
      draftId: createDraftId(requestId, 0, 'root'),
      source: {
        route: 'audit_document',
        originalInput: structuredClone(input) as unknown as Record<string, unknown>,
        document: input.document,
        auditType: input.auditType,
      } as AuditSource,
      prompt: promptParts.join('\n\n'),
      filePaths,
      skipCompletionHeuristic: true,
    }];
  }

  return filePaths.map((filePath, index) => {
    const nodeId = escapeFanoutKey(canonicalizePath(filePath));
    const promptParts: string[] = [];
    promptParts.push(`Audit this file: ${filePath}`);
    if (input.auditType) promptParts.push(`Audit type: ${input.auditType}`);
    promptParts.push(
      'You MUST re-read all target files before comparing against prior findings. Do not audit from the context block alone — the context block contains the prior round\'s findings, not the current file contents.',
      '',
      'Produce a narrative audit report. Number each finding (1, 2, 3, ...). For each finding, on its own line, state:',
      '  Severity: critical | high | medium | low',
      '  Location: file:line (when applicable)',
      '  Issue: one-paragraph explanation',
      '  Suggestion: one-line fix recommendation',
      'The reviewer will extract structured findings from your report — do NOT emit JSON.',
      '',
      SCOPE_CONTRACT,
    );

    return {
      draftId: createDraftId(requestId, index, nodeId),
      source: {
        route: 'audit_document',
        originalInput: structuredClone(input) as unknown as Record<string, unknown>,
        document: input.document,
        auditType: input.auditType,
      } as AuditSource,
      prompt: promptParts.join('\n\n'),
      filePaths: [filePath],
      skipCompletionHeuristic: true,
    };
  });
}
// v4.0 spec C8 slot-style API
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

export function auditSlot(input: AuditInput): AuditBrief[] {
  return input.documentPaths.map((p, i) => ({
    taskIndex: i,
    brief: `Audit ${p} against the following questionnaire:\n${input.questionnaire ?? '(default audit checklist)'}`,
    cwd: input.cwd ?? process.cwd(),
    agentType: 'complex' as const,
    reviewPolicy: 'quality_only' as const,
    contextBlockIds: [],
    documentPath: p,
  }));
}
