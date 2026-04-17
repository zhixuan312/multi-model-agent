import type { ParsedStructuredReport } from '../reporting/structured-report.js';

interface ReviewerPacketInput {
  prompt: string;
  scope: string[];
  doneCondition: string;
}

export function buildSpecReviewPrompt(
  packet: ReviewerPacketInput,
  implReport: ParsedStructuredReport,
  fileContents: Record<string, string>,
  toolCallLog: string[],
): string {
  return [
    'You are a spec compliance reviewer. Check whether the implementer satisfied the task exactly.',
    '',
    '## Execution Packet (what was asked)',
    packet.prompt,
    `Scope: ${packet.scope.join(', ')}`,
    `Done condition: ${packet.doneCondition}`,
    '',
    '## Implementer Structured Report',
    `Summary: ${implReport.summary ?? 'N/A'}`,
    `Files changed: ${implReport.filesChanged.map((f) => `${f.path}: ${f.summary}`).join('; ')}`,
    `Validations run: ${implReport.validationsRun.map((v) => `${v.command}: ${v.result}`).join('; ')}`,
    `Deviations: ${implReport.deviationsFromBrief.join('; ') || 'none'}`,
    `Unresolved: ${implReport.unresolved.join('; ') || 'none'}`,
    '',
    '## Actual File Contents',
    ...Object.entries(fileContents).map(([path, content]) =>
      `### ${path}\n\`\`\`\n${content}\n\`\`\``),
    '',
    '## Tool-Call Log',
    toolCallLog.join('\n'),
    '',
    '## Your Task',
    'Return a structured report. In ## Summary, state your verdict: "approved" or "changes_required".',
    'In ## Deviations from brief, list specific issues found.',
    'In ## Unresolved, list items needing parent judgment.',
    'Check: scope coverage, acceptance criteria met, required markers present, no out-of-scope changes.',
  ].join('\n');
}

export function buildQualityReviewPrompt(
  packet: ReviewerPacketInput,
  implReport: ParsedStructuredReport,
  fileContents: Record<string, string>,
  toolCallLog: string[],
): string {
  return [
    'You are a code quality reviewer. Check whether the implementation is sound, safe, and maintainable.',
    '',
    '## Execution Packet',
    packet.prompt,
    '',
    '## Implementer Structured Report',
    `Summary: ${implReport.summary ?? 'N/A'}`,
    `Files changed: ${implReport.filesChanged.map((f) => `${f.path}: ${f.summary}`).join('; ')}`,
    '',
    '## Actual File Contents',
    ...Object.entries(fileContents).map(([path, content]) =>
      `### ${path}\n\`\`\`\n${content}\n\`\`\``),
    '',
    '## Tool-Call Log',
    toolCallLog.join('\n'),
    '',
    '## Your Task',
    'Return a structured report. In ## Summary, state: "approved" or "changes_required".',
    'In ## Deviations from brief, list code quality issues:',
    '- error handling gaps',
    '- edge cases not covered',
    '- null safety issues',
    '- maintainability concerns',
    '- security surface issues',
    'In ## Unresolved, list items the implementer should address.',
  ].join('\n');
}