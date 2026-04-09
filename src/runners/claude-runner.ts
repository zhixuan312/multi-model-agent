import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { withTimeout, type RunResult, type RunOptions, type ProviderConfig } from '../types.js';
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations } from '../tools/definitions.js';
import { createClaudeToolServer } from '../tools/claude-adapter.js';

export async function runClaude(
  prompt: string,
  options: RunOptions,
  providerConfig: ProviderConfig,
  defaults: { maxTurns: number; timeoutMs: number; tools: 'none' | 'full' },
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? providerConfig.maxTurns ?? defaults.maxTurns;
  const timeoutMs = options.timeoutMs ?? providerConfig.timeoutMs ?? defaults.timeoutMs;
  const toolMode = options.tools ?? defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const effort = options.effort ?? providerConfig.effort;

  const sandboxPolicy = options.sandboxPolicy ?? providerConfig.sandboxPolicy ?? 'cwd-only';
  const abortController = new AbortController();

  const tracker = new FileTracker();
  const toolImpls = createToolImplementations(tracker, cwd, sandboxPolicy, abortController.signal);

  // Permission bypass is intentional for sub-agent use. File-system confinement
  // is enforced by assertWithinCwd in tool definitions when sandboxPolicy is 'cwd-only'.
  const queryOptions: Options = {
    model: providerConfig.model,
    maxTurns,
    cwd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    abortController,
  };

  if (toolMode === 'full') {
    const toolServer = createClaudeToolServer(toolImpls, sandboxPolicy);
    queryOptions.mcpServers = { 'code-tools': toolServer };
    // Enable Claude's built-in WebSearch and WebFetch alongside our MCP code
    // tool server, so the capabilities matrix's claim that claude has
    // web_search + web_fetch is actually true at runtime. Shell is NOT in
    // this list — it stays behind the sandboxPolicy gate via our code-tools
    // MCP server's runShell implementation.
    queryOptions.tools = ['WebSearch', 'WebFetch'];
    queryOptions.allowedTools = ['mcp__code-tools__*', 'WebSearch', 'WebFetch'];
  } else {
    queryOptions.tools = [];
  }

  if (!effort || effort === 'none') {
    queryOptions.thinking = { type: 'disabled' };
  } else {
    queryOptions.thinking = { type: 'adaptive' };
    // effort is typed as EffortLevel in Options; cast from string
    queryOptions.effort = effort as Options['effort'];
  }

  // Hoisted so the timeout callback can read partial progress
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD: number | null = null;
  let turns = 0;

  const run = async (): Promise<RunResult> => {
    let output = '';
    let hitMaxTurns = false;

    try {
      for await (const msg of query({ prompt, options: queryOptions })) {
        if (msg.type === 'assistant') {
          turns++;
        }

        if (msg.type === 'result') {
          if ('result' in msg) {
            output = msg.result;
          }

          if ('subtype' in msg && msg.subtype === 'error_max_turns') {
            hitMaxTurns = true;
          }

          // Extract usage from modelUsage or usage
          if ('modelUsage' in msg && msg.modelUsage) {
            for (const model of Object.values(msg.modelUsage)) {
              inputTokens += model.inputTokens ?? 0;
              outputTokens += model.outputTokens ?? 0;
            }
          } else if ('usage' in msg && msg.usage) {
            const u = msg.usage as unknown as Record<string, number>;
            inputTokens = u['input_tokens'] ?? 0;
            outputTokens = u['output_tokens'] ?? 0;
          }

          if ('total_cost_usd' in msg && typeof msg.total_cost_usd === 'number') {
            costUSD = msg.total_cost_usd;
          }
        }
      }
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUSD },
        turns,
        files: tracker.getFiles(),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    return {
      output: hitMaxTurns ? (output || `Agent exceeded max turns (${maxTurns}).`) : output,
      status: hitMaxTurns ? 'max_turns' : 'ok',
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costUSD,
      },
      turns,
      files: tracker.getFiles(),
    };
  };

  return withTimeout(run(), timeoutMs, () => ({
    files: tracker.getFiles(),
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUSD },
    turns,
  }), abortController);
}
