// Per-route rework-budget constants. Lives here (not in escalation/) because
// the escalation module is going away — these constants are about the rework
// stage's attempt budget, not about tier escalation.

export type ToolCategory = 'artifact_producing' | 'read_only' | 'assist';

export const ATTEMPT_BUDGETS: Record<ToolCategory, number> = {
  artifact_producing: 7,  // 3 spec + 3 quality + 1 diff
  read_only: 2,            // 1 implementer + 1 annotator (no rework)
  assist: 1,               // register_context_block, retry_tasks — sync state ops
};
