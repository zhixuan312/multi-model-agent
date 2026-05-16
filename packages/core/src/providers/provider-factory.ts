// v4.4 provider-factory. Two runtimes, two factories: claude (in-process
// via claude-agent-sdk) and codex (subprocess via codex CLI). The Provider
// exposes only `openSession`; legacy `run`/`runReview` are gone.

import type {
  AgentType, Provider, MultiModelConfig,
} from '../types.js';
import type { ClaudeProviderConfig, CodexProviderConfig } from '../types/config.js';
import type { SessionOpts, Session } from '../types/run-result.js';
import { makeClaudeProvider } from './claude.js';
import { makeCodexProvider } from './codex.js';

let coreTestProviderOverride: Provider | null = null;
let coreTestProviderOverrideMap: Map<AgentType, Provider> | null = null;

// ─── Safety ceiling ────────────────────────────────────────────────────────
// Process-wide counter of live CLI children (codex + claude combined). When
// the count would exceed SAFETY_CEILING, openSession refuses with
// safety_ceiling_exceeded. This is a "should never happen" guard — the per-
// task close-on-end invariant + stuck-detection watchdog should keep us far
// below this in normal operation. Capped at 100 children → up to 50
// concurrent tasks (each task uses ≤2 sessions: 1 standard + 1 complex).
//
const SAFETY_CEILING = 100;
let liveChildren = 0;

/** Test-only — number of currently-live CLI children. */
export function __liveChildren(): number { return liveChildren; }
/** Test-only — process-wide safety ceiling. */
export function __safetyCeiling(): number { return SAFETY_CEILING; }

export class SafetyCeilingExceededError extends Error {
  readonly code = 'safety_ceiling_exceeded';
  constructor(current: number, ceiling: number) {
    super(`safety_ceiling_exceeded: liveChildren=${current} ceiling=${ceiling}`);
  }
}

function wrapWithSafetyCeiling(p: Provider): Provider {
  return {
    name: p.name,
    config: p.config,
    openSession(opts: SessionOpts): Session {
      if (liveChildren >= SAFETY_CEILING) {
        // Bus may not be available — emit through opts.bus if present.
        const bus = (opts.bus as { emit?: (e: Record<string, unknown>) => void } | undefined);
        bus?.emit?.({
          event: 'safety_ceiling_hit',
          ts: new Date().toISOString(),
          severity: 'error',
          liveChildren,
          ceiling: SAFETY_CEILING,
          ...(opts.batchId !== undefined && { batchId: opts.batchId }),
          ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
        });
        throw new SafetyCeilingExceededError(liveChildren, SAFETY_CEILING);
      }
      liveChildren++;
      const inner = p.openSession(opts);
      let decremented = false;
      const dec = (): void => { if (!decremented) { decremented = true; liveChildren--; } };
      return {
        send: inner.send.bind(inner),
        async close(): Promise<void> {
          try { await inner.close(); } finally { dec(); }
        },
        ...(inner.getPid && { getPid: inner.getPid.bind(inner) }),
      };
    },
  };
}

function assertTestProviderEnabled(): void {
  if (process.env.MMAGENT_TEST_PROVIDER_OVERRIDE !== '1') {
    throw new Error('MMAGENT_TEST_PROVIDER_OVERRIDE must be set to 1 to use the test provider override');
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
  if (coreTestProviderOverrideMap?.has(slot)) return wrapWithSafetyCeiling(coreTestProviderOverrideMap.get(slot)!);
  if (coreTestProviderOverride) return wrapWithSafetyCeiling(coreTestProviderOverride);

  const agentConfig = config.agents[slot];
  if (!agentConfig) {
    throw new Error(`Unknown agent slot: "${slot}". Config must have "standard" and "complex".`);
  }

  const apiKey = (agentConfig as { apiKey?: string }).apiKey
    ?? ((agentConfig as { apiKeyEnv?: string }).apiKeyEnv
        ? process.env[(agentConfig as { apiKeyEnv: string }).apiKeyEnv]
        : undefined);

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

  // Preserve the legacy convention: `name = slot` (not `<provider>:<model>`)
  // so existing call sites (e.g., `p.name === 'standard'`) keep working.
  return wrapWithSafetyCeiling({ ...provider, name: slot });
}
