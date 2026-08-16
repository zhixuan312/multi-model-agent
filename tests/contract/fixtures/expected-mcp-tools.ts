import { INITIATIVE_OPERATIONS } from '@zhixuan92/multi-model-agent-core';

/**
 * The MCP tool names the surface must publish, restated INDEPENDENTLY of `tool-surface.ts`.
 *
 * Independence from PRODUCTION is the point: a contract test that imports the very map it is
 * checking asserts only that a value equals itself. So the naming rule is re-derived here from
 * `INITIATIVE_OPERATIONS` plus the override set, and a real regression in the tool surface still
 * fails these assertions.
 *
 * Independence between TEST FILES is not the point, and three of them carried this derivation
 * verbatim — comment included — along with the same seven-name literal. One override added to
 * `tool-surface.ts` meant finding all three; missing one left a test asserting the old rule while
 * its siblings asserted the new one.
 *
 * SPEC-005 Method Registry (Task I-3, FR-10) froze `method_get`, `method_list`, and
 * `initiative_task_set_method` as `mma_initiative_<operation>` rather than the mechanical
 * `mma_<operation>` every other operation uses — see `tool-surface.ts`'s own
 * `INITIATIVE_TOOL_NAME_OVERRIDES`.
 */
const INITIATIVE_TOOL_NAME_OVERRIDES = new Set(['method_get', 'method_list', 'initiative_task_set_method']);

export const INITIATIVE_TOOL_NAMES = INITIATIVE_OPERATIONS.map((operation) =>
  INITIATIVE_TOOL_NAME_OVERRIDES.has(operation) ? `mma_initiative_${operation}` : `mma_${operation}`,
);

/** The tools that predate the per-operation Initiative surface. */
export const BASE_MCP_TOOL_NAMES = [
  'mma_context_block_create',
  'mma_context_block_delete',
  'mma_run',
  'mma_execution_cancel',
  'mma_execution_get',
  'mma_execution_list',
  'mma_execution_wait',
];

/** Every tool name `tools/list` must return, sorted for direct comparison. */
export const EXPECTED_MCP_TOOL_NAMES = [...BASE_MCP_TOOL_NAMES, ...INITIATIVE_TOOL_NAMES].sort();
