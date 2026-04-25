export interface TerminalHeadlineInput {
  tool: string;
  awaitingClarification: boolean;
  tasksTotal: number;
  tasksCompleted: number;
  policyEscalated?: { spec?: boolean; quality?: boolean };
  fallbackCount?: number;
}

export function composeTerminalHeadline(input: TerminalHeadlineInput): string {
  const { tool, awaitingClarification, tasksTotal, tasksCompleted } = input;
  const parts: string[] = [];
  if (awaitingClarification) {
    parts.push(`${tool}: awaiting clarification`);
  } else if (tasksTotal <= 0) {
    parts.push(`${tool}: no tasks executed`);
  } else {
    const completed = Math.max(0, Math.min(tasksCompleted, tasksTotal));
    parts.push(`${tool}: ${completed}/${tasksTotal} tasks complete`);
  }
  if (input.policyEscalated?.spec || input.policyEscalated?.quality) {
    const loops: string[] = [];
    if (input.policyEscalated.spec) loops.push('spec');
    if (input.policyEscalated.quality) loops.push('quality');
    parts.push(`(escalated: ${loops.join(', ')})`);
  }
  if (input.fallbackCount && input.fallbackCount > 0) {
    parts.push(`(fallback: ${input.fallbackCount}x)`);
  }
  return parts.join(' ');
}
