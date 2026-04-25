import type { Provider, TaskSpec, AgentType } from '../types.js';
import type { CommitFields } from '../reporting/structured-report.js';
import { delegateWithEscalation } from '../delegate-with-escalation.js';
import { parseStructuredReport } from '../reporting/structured-report.js';
import { withDoneCondition } from './execute-task.js';

export interface MetadataRepairInput {
  task: TaskSpec;
  zodError: string;
  cwd: string;
  providerSlot: AgentType;
  provider: Provider;
}

export interface MetadataRepairResult {
  commit: CommitFields | null;
  commitDiagnostic: string | null;
}

export async function runMetadataRepairTurn(input: MetadataRepairInput): Promise<MetadataRepairResult> {
  const prompt = [
    'Your previous response had an invalid or missing commit metadata block.',
    `Validation error: ${input.zodError}`,
    '',
    'Emit ONLY a corrected `commit:` JSON block. Do NOT modify any files.',
    'The runner will reject your response if files change between turns.',
    '',
    'Schema:',
    '  type: "feat"|"fix"|"refactor"|"test"|"docs"|"chore"|"style"',
    '  scope: optional, /^[a-z0-9][a-z0-9._/-]{0,23}$/',
    '  subject: 1..50 chars, lowercase first letter, no trailing colon, no leading/trailing whitespace',
    '  body: optional, ≤8 KB plain text',
  ].join('\n');

  const repairTask = withDoneCondition({
    ...input.task,
    prompt,
    cwd: input.cwd,
    reviewPolicy: 'off',
    tools: 'none',
  });

  const r = await delegateWithEscalation(
    repairTask,
    [input.provider],
    { explicitlyPinned: true },
  );
  const report = parseStructuredReport(r.output);
  return { commit: report.commit ?? null, commitDiagnostic: report.commitDiagnostic ?? null };
}
