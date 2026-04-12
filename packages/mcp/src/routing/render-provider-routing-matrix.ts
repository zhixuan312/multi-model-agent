import type { AgentConfig, MultiModelConfig } from '@zhixuan92/multi-model-agent-core';
import { findModelCapabilities, findModelProfile } from '@zhixuan92/multi-model-agent-core/routing/model-profiles';
import type { ModelProfile } from '@zhixuan92/multi-model-agent-core/routing/model-profiles';

const ROUTING_RECIPE = `How to route a task:
1. Select the agent type based on required capabilities.
2. If the selected agent lacks required capabilities, auto-escalate to the other agent type.
3. Among available agents, prefer the one that meets capability requirements.

Agent guidance:
- 'standard' — most code work. Clear spec, multiple valid approaches.
- 'complex' — ambiguous, architectural, research, or high-stakes tasks requiring more reasoning.

Optional 'effort' knob (per task):
- Only agents marked 'effort: supported' in the matrix honor this field.
- Use 'high' for complex tasks when you want maximum depth,
  'medium' for balanced, 'low' for fast-but-shallow, 'none' to disable
  thinking entirely on agents that default it on.`;

const TOOL_NOTES = `Sub-agent tool notes (apply to every agent):
- 'grep' accepts a file OR a directory. When given a directory it searches
  recursively (output is prefixed file:line). Prefer one recursive grep over
  many readFile calls when the worker needs to find usages or patterns.
- Worker output is captured from the final assistant message when present,
  otherwise salvaged from a running scratchpad. You ALWAYS get text back,
  even on 'incomplete' / 'timeout' / 'api_error' / 'network_error' paths.
- Tasks that need shell ('pnpm', 'pytest', 'tsc', 'git') only work on
  agents configured with sandboxPolicy: 'none'. Otherwise keep shell
  work on the parent session, not in a delegated sub-agent.

Escalation, statuses, streaming, and batch helpers:
- Auto-routed tasks (no 'agentType' set) use 'standard' agent.
- If the selected agent lacks required capabilities, auto-escalate to 'complex'.
- If every agent fails, the best salvage is returned and the
  per-task 'escalationLog' shows every attempt.
- Status values: 'ok', 'incomplete', 'max_turns', 'timeout',
  'api_aborted', 'api_error', 'network_error', 'error'.
  'incomplete' = scratchpad salvage after a degenerate completion;
  'api_aborted' = agent-side abort; 'api_error' = HTTP error with
  a numeric .status; 'network_error' = transport failure
  (ECONNREFUSED / ENOTFOUND / /network/i).
- Streaming: if your MCP client passes '_meta.progressToken' on the
  tool call, delegate_tasks forwards per-task progress notifications
  (turn_start, tool_call, text_emission, turn_complete, injection,
  escalation_start, done) back over the MCP progress channel. No
  opt-in needed beyond sending the token.
- Batch helpers: every delegate_tasks response carries a 'batchId'.
  Use 'retry_tasks' with that batchId + a list of 0-based task
  indices to re-run just the failing subset without re-transmitting
  the original briefs. Cache is 30-minute TTL, 100-batch LRU.
- Long shared context: 'register_context_block' stores a blob of
  text on the server and returns an id. Pass that id in
  'contextBlockIds' on any task (alongside 'prompt') and the server
  prepends the blob to the prompt before dispatch — so long briefs
  shared across multiple tasks are sent to the parent session only
  once.

RESPONSE SHAPE (v0.3+): Every delegate_tasks response includes a top-level
batchId, mode ('full' or 'summary'), timings ({wallClockMs, sumOfTaskMs,
estimatedParallelSavingsMs}), batchProgress ({totalTasks, completedTasks,
incompleteTasks, failedTasks, successPercent}), and aggregateCost
({totalActualCostUSD, totalSavedCostUSD, actualCostUnavailableTasks,
savedCostUnavailableTasks}). If the combined output across tasks is small,
mode: 'full' with inline outputs; if it exceeds the server's threshold
(default 64 KB, configurable via env MULTI_MODEL_LARGE_RESPONSE_THRESHOLD_CHARS
/ config defaults.largeResponseThresholdChars / buildMcpServer option),
mode: 'summary' with per-task outputLength + outputSha256 + _fetchWith
hint — fetch individual outputs with get_batch_slice({ batchId, slice: 'output', taskIndex }),
or per-task details with get_batch_slice({ batchId, slice: 'detail', taskIndex }).
Set responseMode: 'full' to force inline, 'summary' to force summary, or
omit for auto-escape.

COVERAGE DECLARATION (v0.3+): For tasks with enumerable deliverables
(multi-file refactors, test generation across many functions, multi-PR
review, per-endpoint reports, per-function test stubs, audit checklists),
set expectedCoverage on the task spec with either minSections: N,
sectionPattern: '<regex>' (default ^##), or requiredMarkers: [...] — the
identifier strings that must all appear in the output. The supervision
layer will re-prompt the model with specific missing items and classify
thin responses as insufficient_coverage instead of silently accepting them.
Do NOT set expectedCoverage for one-shot tasks (bug fixes, single
implementations, prose, creative writing) — the field is opt-in and has
no meaning for deliverables you can't enumerate ahead of time.

COST + TIME VISIBILITY (v0.3+): Set parentModel on the task spec (e.g.
'claude-opus-4-6') to get usage.savedCostUSD — the ESTIMATED cost
difference vs running the same token volume on that parent model.
Positive means delegation was cheaper. Both usage.costUSD (actual) and
usage.savedCostUSD (estimate) are estimates for budgeting and debugging,
not accounting numbers. Per-task durationMs is always populated.
Batch-level timings.estimatedParallelSavingsMs tells you how much
wall-clock time concurrent dispatch bought back vs a hypothetical
serial for-loop. batchProgress.successPercent is a clean-success rate
(the batch is always 100% done by the time you see the response —
successPercent measures how many finished cleanly, NOT progress).

AVAILABLE TOOLS: delegate_tasks (this one), register_context_block
(stash reusable brief content referenced via TaskSpec.contextBlockIds),
retry_tasks (re-dispatch specific indices from a previous batch),
get_batch_slice (fetch outputs/details/telemetry when a response was in
summary mode or for per-task introspection).`;

function renderAgentBlock(
  name: string,
  config: AgentConfig,
  capabilities: ('web_search' | 'web_fetch')[],
  profile: ModelProfile,
): string {
  const effortLabel = profile.supportsEffort ? 'supported' : 'not supported';
  const lines = [
    `${name} (${config.model})`,
    `  capabilities: ${capabilities.join(', ') || '(none)'}`,
    `  cost: ${profile.defaultCost} | effort: ${effortLabel}`,
    `  best for: ${profile.bestFor}`,
  ];
  if (profile.notes) {
    lines.push(`  note: ${profile.notes}`);
  }
  if (profile.avoidFor) {
    lines.push(`  avoid for: ${profile.avoidFor}`);
  }
  return lines.join('\n');
}

/**
 * Renders the full routing matrix for the MCP tool description.
 * Helps the consuming LLM understand agent capabilities and routing rules.
 */
export function renderProviderRoutingMatrix(config: MultiModelConfig): string {
  if (!config.agents) {
    return 'No agents configured.';
  }

  const blocks = Object.entries(config.agents).map(([name, agentConfig]) => {
    const capabilities = agentConfig.capabilities ?? findModelCapabilities(agentConfig.model);
    const profile = findModelProfile(agentConfig.model);
    return renderAgentBlock(name, agentConfig, capabilities, profile);
  });

  return [
    'Delegate tasks to sub-agents running on different LLM models.',
    'All tasks execute concurrently.',
    '',
    'Available agents:',
    '',
    blocks.join('\n\n'),
    '',
    ROUTING_RECIPE,
    '',
    TOOL_NOTES,
  ].join('\n');
}
