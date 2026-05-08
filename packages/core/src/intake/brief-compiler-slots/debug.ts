export interface ToolDebugBrief {
  problem: string;
  context?: string;
  hypothesis?: string;
  filePaths?: string[];
  contextBlockIds?: string[];
}

export function debugBriefSlot(input: {
  problem: string;
  context?: string;
  hypothesis?: string;
  filePaths?: string[];
  contextBlockIds?: string[];
}): ToolDebugBrief[] {
  return [{
    problem: input.problem,
    context: input.context,
    hypothesis: input.hypothesis,
    filePaths: input.filePaths,
    contextBlockIds: input.contextBlockIds,
  }];
}
