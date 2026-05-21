// Public schema barrel entry for execute-plan. The live route schema is
// `executePlanInputSchema` (in tool-config.ts) — exposed here as `inputSchema`
// + `outputSchema` so tools/index.ts and contract tests see the same surface
// the HTTP handler uses. (Replaces the orphaned execute-plan/schema.ts that
// diverged from the live route.)
export { executePlanInputSchema as inputSchema, outputSchema } from './tool-config.js';
