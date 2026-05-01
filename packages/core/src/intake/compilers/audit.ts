import type { DraftTask, AuditSource } from '../types.js';
import { createDraftId, escapeFanoutKey, canonicalizePath } from '../draft-id.js';

export interface AuditDocumentInput {
  document?: string;
  filePaths?: string[];
  auditType?: string;
}

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