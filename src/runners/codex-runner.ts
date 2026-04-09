import OpenAI from 'openai';
import { z } from 'zod';
import type { Response, ResponseInputItem } from 'openai/resources/responses/responses';
import { getCodexAuth } from '../auth/codex-oauth.js';
import { withTimeout, type RunResult, type RunOptions, type ProviderConfig } from '../types.js';
import { FileTracker } from '../tools/tracker.js';
import { createToolImplementations, type ToolImplementations } from '../tools/definitions.js';
import type { SandboxPolicy } from '../types.js';

/**
 * Holds the raw body text of the last HTTP response that returned a 4xx/5xx.
 * The OpenAI SDK wraps errors into APIError but strips the body text when it
 * can't be parsed as JSON, leaving "400 status code (no body)". We capture it
 * ourselves via a custom fetch so we can surface actionable diagnostics.
 */
export interface RawErrorCapture {
  status: number;
  bodyText: string;
  url: string;
  requestBodyPreview?: string;
}

export function createCodexClient(capture?: { last?: RawErrorCapture }): OpenAI {
  const debug = process.env.CODEX_DEBUG === '1';

  // A custom fetch that tees error-response bodies into `capture`.
  const wrappedFetch: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    if (!res.ok && capture) {
      const cloned = res.clone();
      let bodyText = '';
      try { bodyText = await cloned.text(); } catch { /* ignore */ }
      capture.last = {
        status: res.status,
        bodyText,
        url: String(url),
        requestBodyPreview: typeof init?.body === 'string' ? init.body.slice(0, 2000) : undefined,
      };
      if (debug) {
        // eslint-disable-next-line no-console
        console.error('[codex-runner] HTTP', res.status, String(url));
        // eslint-disable-next-line no-console
        if (bodyText) console.error('[codex-runner] body:', bodyText.slice(0, 1000));
        // eslint-disable-next-line no-console
        if (typeof init?.body === 'string') console.error('[codex-runner] request:', init.body.slice(0, 1000));
      }
    }
    return res;
  };

  // Try Codex OAuth first — route through chatgpt.com backend API
  const auth = getCodexAuth();
  if (auth) {
    return new OpenAI({
      apiKey: auth.accessToken,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: {
        'chatgpt-account-id': auth.accountId,
      },
      fetch: wrappedFetch,
    });
  }

  // Fall back to OPENAI_API_KEY env var — uses standard api.openai.com
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return new OpenAI({ apiKey, fetch: wrappedFetch });
  }

  throw new Error(
    'No Codex credentials found. Run `codex login` or set OPENAI_API_KEY environment variable.',
  );
}

/**
 * Tool definitions for the Codex Responses API.
 *
 * These mirror src/tools/openai-adapter.ts but use JSON schema directly
 * instead of zod (the Responses API tool format does not accept zod schemas).
 */
interface CodexTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

function buildCodexTools(impl: ToolImplementations, sandboxPolicy: SandboxPolicy): CodexTool[] {
  const tools: CodexTool[] = [
    {
      name: 'read_file',
      description: 'Read the contents of a file at the given path. Returns the full file content as a string.',
      parameters: z.toJSONSchema(z.object({
        path: z.string().describe('Absolute or relative file path'),
      })) as Record<string, unknown>,
      execute: async (args) => impl.readFile(args.path as string),
    },
    {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed. Overwrites existing files.',
      parameters: z.toJSONSchema(z.object({
        path: z.string().describe('File path to write to'),
        content: z.string().describe('Content to write'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        await impl.writeFile(args.path as string, args.content as string);
        return `File written: ${args.path}`;
      },
    },
    {
      name: 'glob',
      description: 'Find files matching a glob pattern in the working directory.',
      parameters: z.toJSONSchema(z.object({
        pattern: z.string().describe('Glob pattern (e.g., "*.ts", "src/**/*.js")'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const files = await impl.glob(args.pattern as string);
        return files.join('\n') || 'No files found.';
      },
    },
    {
      name: 'grep',
      description: 'Search for a pattern in a file. Returns matching lines with line numbers.',
      parameters: z.toJSONSchema(z.object({
        pattern: z.string().describe('Search pattern (regex)'),
        path: z.string().describe('File path to search in'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const result = await impl.grep(args.pattern as string, args.path as string);
        return result || 'No matches found.';
      },
    },
    {
      name: 'list_files',
      description: 'List files and directories at the given path. Directories have a trailing "/".',
      parameters: z.toJSONSchema(z.object({
        path: z.string().default('.').describe('Directory path to list'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const entries = await impl.listFiles((args.path as string) ?? '.');
        return entries.join('\n') || 'Empty directory.';
      },
    },
  ];

  if (sandboxPolicy !== 'cwd-only') {
    tools.push({
      name: 'run_shell',
      description: 'Execute a shell command and return stdout, stderr, and exit code. Use for running tests, installing packages, etc.',
      parameters: z.toJSONSchema(z.object({
        command: z.string().describe('Shell command to execute'),
      })) as Record<string, unknown>,
      execute: async (args) => {
        const result = await impl.runShell(args.command as string);
        return JSON.stringify(result);
      },
    });
  }

  return tools;
}

export async function runCodex(
  prompt: string,
  options: RunOptions,
  providerConfig: ProviderConfig,
  defaults: { maxTurns: number; timeoutMs: number; tools: 'none' | 'full' },
): Promise<RunResult> {
  const maxTurns = options.maxTurns ?? providerConfig.maxTurns ?? defaults.maxTurns;
  const timeoutMs = options.timeoutMs ?? providerConfig.timeoutMs ?? defaults.timeoutMs;
  const toolMode = options.tools ?? defaults.tools;
  const cwd = options.cwd ?? process.cwd();
  const sandboxPolicy = options.sandboxPolicy ?? providerConfig.sandboxPolicy ?? 'cwd-only';
  const effort = options.effort ?? providerConfig.effort;

  const abortController = new AbortController();
  const tracker = new FileTracker();
  const toolImpls = createToolImplementations(tracker, cwd, sandboxPolicy, abortController.signal);

  const codexTools = toolMode === 'full' ? buildCodexTools(toolImpls, sandboxPolicy) : [];
  const toolsByName = new Map(codexTools.map(t => [t.name, t]));
  const responsesTools = codexTools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));

  // Auto-enable web_search for codex unless the user explicitly set hostedTools
  // (including an explicit empty array to opt out). This keeps the capability
  // matrix's claim that codex has web_search true at default settings — the
  // user's guiding principle is to minimize required config.
  const configuredHostedTools = providerConfig.hostedTools ?? ['web_search'];
  const hostedTools = toolMode === 'full'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? configuredHostedTools.map(t => ({ type: t } as any))
    : [];
  const allTools = [...responsesTools, ...hostedTools];

  // Accumulated state (hoisted so the timeout callback can read partial progress)
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  const run = async (): Promise<RunResult> => {
    const capture: { last?: RawErrorCapture } = {};
    const client = createCodexClient(capture);
    const input: ResponseInputItem[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: 'user', content: prompt } as any,
    ];

    let output = '';
    let lastResponseStatus: string | null = null;

    try {
      while (turns < maxTurns) {
        turns++;

        // Codex backend requires streaming. The Codex backend's
        // `response.completed` event does NOT populate `response.output` —
        // we must accumulate content from individual stream events.
        // `instructions` is required (mirrors gumi-agent's proven shape).
        const stream = await client.responses.create({
          model: providerConfig.model,
          instructions: prompt,
          input,
          stream: true,
          store: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: allTools.length > 0 ? (allTools as any) : undefined,
          // Honor `effort` when set and not 'none'. Codex backend accepts
          // reasoning.effort for reasoning-capable models (gpt-5-codex, o3, etc.).
          // 'none' skips the reasoning block entirely.
          ...(effort && effort !== 'none' && {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            reasoning: { effort } as any,
          }),
        }, { signal: abortController.signal });

        let textThisTurn = '';
        const toolCalls: Array<{ call_id: string; name: string; arguments: string; item?: unknown }> = [];
        const itemTypesSeen: string[] = [];
        const completedItems: unknown[] = [];
        let sawCompleted = false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const event of stream as any) {
          const et = event?.type as string | undefined;
          if (!et) continue;

          if (et === 'response.output_text.delta') {
            textThisTurn += event.delta ?? '';
          } else if (et === 'response.output_item.added') {
            if (event.item?.type) itemTypesSeen.push(event.item.type);
          } else if (et === 'response.output_item.done') {
            const item = event.item;
            if (item) {
              completedItems.push(item);
              if (item.type === 'function_call') {
                toolCalls.push({
                  call_id: item.call_id,
                  name: item.name,
                  arguments: item.arguments ?? '',
                  item,
                });
              }
            }
          } else if (et === 'response.completed') {
            sawCompleted = true;
            const r = event.response as Response | undefined;
            if (r?.usage) {
              inputTokens += r.usage.input_tokens ?? 0;
              outputTokens += r.usage.output_tokens ?? 0;
            }
            if (r?.status) lastResponseStatus = r.status;
          }
        }

        if (process.env.CODEX_DEBUG === '1') {
          // eslint-disable-next-line no-console
          console.error('[codex-runner] item types streamed:', itemTypesSeen.join(', ') || '(none)');
          // eslint-disable-next-line no-console
          console.error('[codex-runner] text this turn:', JSON.stringify(textThisTurn));
          // eslint-disable-next-line no-console
          console.error('[codex-runner] tool calls:', toolCalls.length);
        }

        if (!sawCompleted) {
          throw new Error('Codex stream ended without a response.completed event');
        }

        // Preserve completed items in conversation for the next turn
        for (const item of completedItems) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input.push(item as any);
        }

        if (textThisTurn) {
          output = textThisTurn;
        } else if (toolCalls.length === 0) {
          output = `[codex returned no text — items streamed: ${itemTypesSeen.join(', ') || '(none)'}]`;
        }

        // If the model made no tool calls, it's done
        if (toolCalls.length === 0) {
          return {
            output,
            status: 'ok',
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              costUSD: null,
            },
            turns,
            files: tracker.getFiles(),
          };
        }

        // Execute tool calls and feed outputs back
        for (const call of toolCalls) {
          const tool = toolsByName.get(call.name);
          let result: string;
          if (!tool) {
            result = `Error: unknown tool "${call.name}"`;
          } else {
            try {
              const args = call.arguments ? JSON.parse(call.arguments) : {};
              result = await tool.execute(args);
            } catch (err) {
              result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: result,
          });
        }
      }

      // Max turns exhausted
      return {
        output: output || `Agent exceeded max turns (${maxTurns}).`,
        status: 'max_turns',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUSD: null,
        },
        turns,
        files: tracker.getFiles(),
      };
    } catch (err) {
      // OpenAI SDK's APIError carries status/body/headers — surface them
      // since the Codex backend returns 400 with no body on shape mismatches.
      // We also consult `capture.last` which holds the raw HTTP body captured
      // by our wrapped fetch (the SDK strips the body when it can't parse JSON).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      const pieces: string[] = [];
      if (err instanceof Error) pieces.push(err.message);
      if (e?.status) pieces.push(`HTTP ${e.status}`);
      if (e?.error) {
        try { pieces.push(`sdk_body=${JSON.stringify(e.error)}`); } catch { /* ignore */ }
      }
      if (capture.last) {
        pieces.push(`raw_status=${capture.last.status}`);
        // Only leak request/response body snippets when debug is explicitly enabled;
        // they may contain sensitive content (prompt, tools, file contents).
        if (process.env.CODEX_DEBUG === '1' && capture.last.bodyText) pieces.push(`raw_body=${capture.last.bodyText.slice(0, 500)}`);
        if (process.env.CODEX_DEBUG === '1' && capture.last.requestBodyPreview) pieces.push(`req_body=${capture.last.requestBodyPreview.slice(0, 500)}`);
      }
      if (e?.requestID) pieces.push(`req_id=${e.requestID}`);
      if (lastResponseStatus) pieces.push(`last response status: ${lastResponseStatus}`);
      const detailed = pieces.join(' | ') || String(err);

      return {
        output: `Sub-agent error: ${detailed}`,
        status: 'error',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUSD: null,
        },
        turns,
        files: tracker.getFiles(),
        error: detailed,
      };
    }
  };

  return withTimeout(run(), timeoutMs, () => ({
    files: tracker.getFiles(),
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUSD: null },
    turns,
  }), abortController);
}
