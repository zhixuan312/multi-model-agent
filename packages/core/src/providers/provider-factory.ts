// Provider factory. Three agent tiers (standard, complex, main), two runtimes
// (claude via agent-sdk, codex via CLI). Provider exposes only `openSession`.

import type {
  AgentType, Provider, MultiModelConfig,
} from '../types.js';
import type { ClaudeProviderConfig, CodexProviderConfig } from '../types/config.js';
import type { AgentConfig } from '../types/config.js';
import type { SessionOpts, Session, TurnResult } from '../types/run-result.js';
import { makeClaudeProvider } from './claude.js';
import { makeCodexProvider } from './codex.js';

let coreTestProviderOverride: Provider | null = null;
let coreTestProviderOverrideMap: Map<AgentType, Provider> | null = null;

export type ProviderAuthMode = 'oauth' | 'api-key';

export interface AuthFailureDetails {
  code: 'missing_credentials' | 'invalid_api_key';
  message: string;
}

const MISSING_CREDENTIALS_PATTERNS = [
  /missing credentials/i,
  /no api key/i,
  /api key .*required/i,
  /could not find.*api key/i,
  /oauth token.*not available/i,
  /log in .*codex/i,
  /auth\.json.*not found/i,
];

const INVALID_API_KEY_PATTERNS = [
  /invalid api key/i,
  /incorrect api key/i,
  /401\b/i,
  /unauthorized/i,
  /authentication failed/i,
];

export function resolveConfiguredApiKey(
  agentConfig: Pick<AgentConfig, 'apiKey' | 'apiKeyEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return agentConfig.apiKey
    ?? (agentConfig.apiKeyEnv ? env[agentConfig.apiKeyEnv] : undefined);
}

export function resolveConfiguredAuthMode(
  agentConfig: Pick<AgentConfig, 'apiKey' | 'apiKeyEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): ProviderAuthMode {
  return resolveConfiguredApiKey(agentConfig, env) ? 'api-key' : 'oauth';
}

export function classifyAuthFailure(args: {
  tier: AgentType;
  provider: 'claude' | 'codex';
  errorCode?: string;
  errorMessage?: string;
}): AuthFailureDetails | null {
  const message = args.errorMessage ?? '';

  if (MISSING_CREDENTIALS_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      code: 'missing_credentials',
      message: `${args.tier} tier ${args.provider} provider is missing credentials`,
    };
  }

  if (INVALID_API_KEY_PATTERNS.some((pattern) => pattern.test(message))) {
    return {
      code: 'invalid_api_key',
      message: `${args.tier} tier ${args.provider} provider rejected the configured API key`,
    };
  }

  return null;
}

// ─── Safety ceiling ────────────────────────────────────────────────────────
// Hard cap on live provider sessions per task — a backstop against a runaway
// pipeline spawning unbounded sub-agents. Enforced in createProvider via
// __liveByTask; breaching it throws SafetyCeilingExceededError.
const SAFETY_CEILING = 100;
export class SafetyCeilingExceededError extends Error {
  readonly code = 'safety_ceiling_exceeded';
  constructor(current: number, ceiling: number) {
    super(`safety_ceiling_exceeded: liveChildren=${current} ceiling=${ceiling}`);
  }
}

const liveByTask = new Map<string, Map<string, Session>>();

export class TaskSessionLimitExceededError extends Error {
  readonly code = 'task_session_limit_exceeded';
  constructor(taskKey: string, limit: number) {
    super(`task_session_limit_exceeded: taskKey=${taskKey} limit=${limit}`);
  }
}

export class MissingTaskIdentityError extends Error {
  readonly code = 'missing_task_identity';
  constructor() {
    super('missing_task_identity: openSession requires opts.taskId and opts.taskIndex');
  }
}

/** Test-only snapshot of the per-task live-sessions map.
 *  Returns Maps of sessionId → Session (handles included). */
export function __liveByTask(): Map<string, Map<string, Session>> {
  const snap = new Map<string, Map<string, Session>>();
  for (const [k, v] of liveByTask) snap.set(k, new Map(v));
  return snap;
}

function sumOfAllLive(): number {
  let n = 0;
  for (const v of liveByTask.values()) n += v.size;
  return n;
}

function taskKey(opts: SessionOpts): string {
  if (opts.taskId === undefined || opts.taskIndex === undefined) {
    throw new MissingTaskIdentityError();
  }
  return `${opts.taskId}:${opts.taskIndex}`;
}

function wrapWithSafetyCeiling(p: Provider): Provider {
  return {
    name: p.name,
    config: p.config,
    openSession(opts: SessionOpts): Session {
      const key = taskKey(opts); // throws MissingTaskIdentityError if missing
      const existing = liveByTask.get(key)?.size ?? 0;
      if (existing >= 2) {
        throw new TaskSessionLimitExceededError(key, 2);
      }
      if (sumOfAllLive() >= SAFETY_CEILING) {
        const bus = (opts.bus as { emit?: (e: Record<string, unknown>) => void } | undefined);
        bus?.emit?.({
          event: 'safety_ceiling_hit',
          ts: new Date().toISOString(),
          severity: 'error',
          liveChildren: sumOfAllLive(),
          ceiling: SAFETY_CEILING,
          ...(opts.taskId !== undefined && { taskId: opts.taskId }),
          ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
        });
        throw new SafetyCeilingExceededError(sumOfAllLive(), SAFETY_CEILING);
      }
      // Open underlying session FIRST — sync throws don't leak the counter.
      const inner = p.openSession(opts);
      const sessionId = `${key}:${Math.random().toString(36).slice(2, 10)}`;
      let removed = false;
      const removeFromMap = (): void => {
        if (removed) return;
        removed = true;
        const live = liveByTask.get(key);
        if (live) {
          live.delete(sessionId);
          if (live.size === 0) liveByTask.delete(key);
        }
      };
      // Build the wrapped Session that close() in the normal path uses.
      const wrapped: Session = {
        async send(instruction, turnOpts): Promise<TurnResult> {
          const turn = await inner.send(instruction, turnOpts);
          const authFailure = classifyAuthFailure({
            tier: p.name as AgentType,
            provider: (p.config.type ?? 'codex') as 'claude' | 'codex',
            errorCode: turn.errorCode,
            errorMessage: turn.errorMessage,
          });
          if (!authFailure) return turn;
          return {
            ...turn,
            errorCode: authFailure.code,
            errorMessage: authFailure.message,
          };
        },
        async close(): Promise<void> {
          try { await inner.close(); } finally { removeFromMap(); }
        },
        ...(inner.getPid && { getPid: inner.getPid.bind(inner) }),
        getSessionId: inner.getSessionId.bind(inner),
      };
      // Register AFTER the inner open succeeded. Store the WRAPPED Session
      // so releaseTask() can call .close() (which routes to inner.close()
      // AND removes from the map via the same removeFromMap guard).
      const map = liveByTask.get(key) ?? new Map<string, Session>();
      map.set(sessionId, wrapped);
      liveByTask.set(key, map);
      return wrapped;
    },
  };
}

function assertTestProviderEnabled(): void {
  if (process.env.MMA_TEST_PROVIDER_OVERRIDE !== '1') {
    throw new Error('MMA_TEST_PROVIDER_OVERRIDE must be set to 1 to use the test provider override');
  }
}

export function __setCoreTestProviderOverride(provider: Provider | null): void {
  assertTestProviderEnabled();
  coreTestProviderOverride = provider;
}

export function __setCoreTestProviderOverrideMap(map: Map<AgentType, Provider> | null): void {
  assertTestProviderEnabled();
  coreTestProviderOverrideMap = map;
}

export function createProvider(slot: AgentType, config: MultiModelConfig): Provider {
  if (coreTestProviderOverrideMap?.has(slot)) {
    return wrapWithSafetyCeiling({ ...coreTestProviderOverrideMap.get(slot)!, name: slot });
  }
  if (coreTestProviderOverride) {
    return wrapWithSafetyCeiling({ ...coreTestProviderOverride, name: slot });
  }

  const agentConfig = config.agents[slot] ?? (slot === 'main' ? config.agents.complex : undefined);
  if (!agentConfig) {
    throw new Error(`Unknown agent slot: "${slot}". Config must have "standard" and "complex".`);
  }

  const apiKey = resolveConfiguredApiKey(agentConfig);
  const baseUrl = (agentConfig as { baseUrl?: string }).baseUrl;
  const apiKeyEnv = (agentConfig as { apiKeyEnv?: string }).apiKeyEnv;

  let provider: Provider;
  switch (agentConfig.type) {
    case 'claude':
      provider = makeClaudeProvider({
        type: 'claude',
        model: agentConfig.model,
        ...(apiKey && { apiKey }),
        ...(apiKeyEnv && { apiKeyEnv }),
        ...(baseUrl && { baseUrl }),
      } as ClaudeProviderConfig);
      break;
    case 'codex':
      provider = makeCodexProvider({
        type: 'codex',
        model: agentConfig.model,
        ...(apiKey && { apiKey }),
        ...(apiKeyEnv && { apiKeyEnv }),
        ...(baseUrl && { baseUrl }),
      } as CodexProviderConfig);
      break;
    default:
      throw new Error(`Unknown agent type for slot "${slot}": ${(agentConfig as { type: string }).type}`);
  }

  // Provider name = tier slot so call sites can match by tier (e.g. `p.name === 'standard'`).
  return wrapWithSafetyCeiling({ ...provider, name: slot });
}
