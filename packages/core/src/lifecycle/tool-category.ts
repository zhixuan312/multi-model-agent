// Tool route → category classification used by routing + lifecycle gating.
//   artifact_producing — writes files (delegate, execute-plan, debug, …)
//   read_only          — reads/reports only (audit, review, investigate, …)
//   assist             — sync state ops (register_context_block, retry_tasks)

export type ToolCategory = 'artifact_producing' | 'read_only' | 'assist';
