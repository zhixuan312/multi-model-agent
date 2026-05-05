/**
 * Shared test helpers used across the test suite.
 *
 * Used for HTTP handler invocation, mock providers, and other test fixtures
 * common across multiple test files. If a new helper is needed by 2+ tests,
 * append it here — do NOT redefine inline in each test file.
 */
import type { Provider, RunResult, TaskSpec } from '../../packages/core/src/types.js';

// ---- HTTP handler invocation ---------------------------------------------

export interface InvokeResult<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

/**
 * Invoke an HTTP handler with a JSON body. Captures status, body, headers from
 * a stub Express-style res. The handler MUST call res.status(N).json(B) or
 * res.json(B) (default 200). Throws if the handler never responds.
 */
export async function invokeHandler<T = unknown>(
  handler: (req: any, res: any, ...rest: any[]) => any | Promise<any>,
  body: unknown,
  extra: { headers?: Record<string, string>; query?: Record<string, string>; deps?: any } = {},
): Promise<InvokeResult<T>> {
  let captured: { status: number; body: unknown; headers: Record<string, string> } | null = null;
  const res: any = {
    statusCode: 200,
    _headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(k: string, v: string) { this._headers[k.toLowerCase()] = v; return this; },
    json(b: unknown) {
      captured = { status: this.statusCode, body: b, headers: this._headers };
      return this;
    },
    send(b: unknown) { return this.json(b); },
  };
  const req = {
    body,
    headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
    query: extra.query ?? {},
  };
  const args = extra.deps !== undefined ? [req, res, extra.deps] : [req, res];
  await handler(...(args as [any, any]));
  if (!captured) throw new Error('test-harness: handler never called res.json/res.send');
  return captured as InvokeResult<T>;
}

/**
 * Convenience for /health, which takes deps as third argument.
 */
export async function invokeHealthHandler<T = unknown>(
  deps: { manifestSync: { driftReport: () => any[] } },
  handler?: (req: any, res: any, deps: any) => any | Promise<any>,
): Promise<InvokeResult<T>> {
  const h = handler ?? ((_req: any, res: any) => res.json({}));
  return invokeHandler<T>(h, undefined, { deps });
}

// ---- mockProvider --------------------------------------------------------

export interface MockProviderTurn {
  assistantText: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
}
export interface MockProviderOptions {
  turns: MockProviderTurn[];
  usage?: any;
  throwOnTurn?: Error;
}

/**
 * Loose mockProvider that satisfies the Provider interface (run/runReview)
 * for tests that don't actually exercise the runner. Real runner tests should
 * use the canonical mock-providers in tests/contract/fixtures/mock-providers.ts.
 */
export function mockProvider(opts: MockProviderOptions): Provider {
  return new Proxy({} as Provider, {
    get(_t, key) {
      if (key === 'name') return 'mock';
      if (key === 'config') return { type: 'claude', model: 'mock' };
      if (key === 'run' || key === 'runReview') {
        return async () => {
          if (opts.throwOnTurn) throw opts.throwOnTurn;
          const turn = opts.turns[0] ?? { assistantText: '', toolCalls: [] };
          return {
            finalAssistantText: turn.assistantText,
            toolCalls: turn.toolCalls ?? [],
            usage: opts.usage ?? {},
          } as unknown as RunResult;
        };
      }
      return undefined;
    },
  });
}

// ---- mockAdapter (v4 RunnerAdapter shape) --------------------------------

export interface MockAdapterTurn {
  assistantText: string;
  toolCalls?: Array<{ id?: string; name: string; input: unknown }>;
  finishReason?: 'stop' | 'tool_use' | 'max_tokens';
}
export interface MockAdapterOptions {
  turns: MockAdapterTurn[];
  usage?: any;
  throwOnTurn?: Error;
  providerType?: 'claude' | 'claude-compatible' | 'openai' | 'openai-compatible' | 'codex';
}

/**
 * Adapter conforming to the Phase 3.5 RunnerAdapter contract. Use for any
 * test that constructs a RunnerShell. Returns one turn per call; after `turns`
 * is exhausted, returns an empty stop-turn.
 */
export function mockAdapter(opts: MockAdapterOptions): {
  providerType: NonNullable<MockAdapterOptions['providerType']>;
  turn: (input: any) => Promise<any>;
} {
  let i = 0;
  return {
    providerType: opts.providerType ?? 'claude',
    async turn(_input: any) {
      if (opts.throwOnTurn) throw opts.throwOnTurn;
      const t = opts.turns[i++] ?? { assistantText: '', toolCalls: [], finishReason: 'stop' as const };
      return {
        assistantText: t.assistantText,
        toolCalls: t.toolCalls ?? [],
        usage: opts.usage ?? {},
        finishReason: t.finishReason ?? ((t.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'stop'),
      };
    },
  };
}

// ---- failProvider --------------------------------------------------------

/**
 * Provider that throws on every call — for testing error-path behavior.
 */
export function failProvider(message: string, errorCode = 'runner_crash'): Provider {
  return new Proxy({} as Provider, {
    get(_t, key) {
      if (key === 'name') return 'fail';
      if (key === 'config') return { type: 'claude', model: 'fail' };
      if (key === 'run' || key === 'runReview') {
        return async () => {
          const e: any = new Error(message);
          e.errorCode = errorCode;
          throw e;
        };
      }
      return undefined;
    },
  });
}

// Re-export TaskSpec so test snippets can import it from this single file.
export type { TaskSpec };
