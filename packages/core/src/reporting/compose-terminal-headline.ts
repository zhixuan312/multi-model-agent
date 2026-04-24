export interface TerminalHeadlineInput {
  tool: string;
  awaitingClarification: boolean;
  tasksTotal: number;
  tasksCompleted: number;
}

export function composeTerminalHeadline(input: TerminalHeadlineInput): string {
  const { tool, awaitingClarification, tasksTotal, tasksCompleted } = input;
  if (awaitingClarification) return `${tool}: awaiting clarification`;
  if (tasksTotal <= 0) return `${tool}: no tasks executed`;
  const completed = Math.max(0, Math.min(tasksCompleted, tasksTotal));
  return `${tool}: ${completed}/${tasksTotal} tasks complete`;
}
