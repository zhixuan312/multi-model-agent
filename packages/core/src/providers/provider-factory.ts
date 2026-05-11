// v4.4 provider-factory. Constructs the v4.4 Provider via the per-provider
// factories (makeClaudeProvider, makeOpenAIProvider, makeCodexProvider) and
// also attaches a legacy `run` shim that routes through openSession+send
// so handlers that haven't migrated yet (PR steps 4–6) keep working until
// Task 24 deletes the shim along with `runner-shell.ts`.

import type {
  AgentType, Provider, RunResult, MultiModelConfig,
} from '../types.js';
import type { RunOptions } from './runner-types.js';
import type { Session } from '../types/run-result.js';
import { makeClaudeProvider, type ClaudeProviderConfig } from './claude.js';
import { makeOpenAIProvider, type OpenAIProviderConfig } from './openai.js';
import { makeCodexProvider, type CodexProviderConfig } from './codex.js';
import { assembleRunResult } from './assemble-run-result.js';

let coreTestProviderOverride: Provider | null = null;
let coreTestProviderOverrideMap: Map<AgentType, Provider> | null = null;

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

/** @deprecated v4.4 transitional shim. Throws — no longer constructs adapters;
 *  the runner-shell/adapter layer is replaced by openSession-based providers.
 *  Kept only so `make-runner-shell.ts` compiles until Task 24 deletes it. */
export function buildAdapter(_agentConfig: unknown): never {
  throw new Error('buildAdapter is removed in v4.4. Use Provider.openSession() instead.');
}

export function createProvider(slot: AgentType, config: MultiModelConfig): Provider {
  if (coreTestProviderOverrideMap?.has(slot)) return coreTestProviderOverrideMap.get(slot)!;
  if (coreTestProviderOverride) return coreTestProviderOverride;

  const agentConfig = config.agents[slot];
  if (!agentConfig) {
    throw new Error(`Unknown agent slot: "${slot}". Config must have "standard" and "complex".`);
  }

  const apiKey = (agentConfig as { apiKey?: string }).apiKey
    ?? ((agentConfig as { apiKeyEnv?: string }).apiKeyEnv
        ? process.env[(agentConfig as { apiKeyEnv: string }).apiKeyEnv]
        : undefined);

  let provider: Provider;
  switch (agentConfig.type) {
    case 'claude':
    case 'claude-compatible':
      provider = makeClaudeProvider({
        type: agentConfig.type,
        model: agentConfig.model,
        ...(apiKey && { apiKey }),
        ...((agentConfig as { baseUrl?: string }).baseUrl && { baseUrl: (agentConfig as { baseUrl: string }).baseUrl }),
      } as ClaudeProviderConfig);
      break;
    case 'openai-compatible':
      provider = makeOpenAIProvider({
        type: 'openai-compatible',
        model: agentConfig.model,
        apiKey: apiKey ?? 'not-needed',
        ...((agentConfig as { baseUrl?: string }).baseUrl && { baseUrl: (agentConfig as { baseUrl: string }).baseUrl }),
      } as OpenAIProviderConfig);
      break;
    case 'codex':
      provider = makeCodexProvider({
        type: 'codex',
        model: agentConfig.model,
        ...(apiKey && { apiKey }),
        ...((agentConfig as { baseUrl?: string }).baseUrl && { baseUrl: (agentConfig as { baseUrl: string }).baseUrl }),
      } as CodexProviderConfig);
      break;
    default:
      throw new Error(`Unknown agent type for slot "${slot}": ${(agentConfig as { type: string }).type}`);
  }

  // Legacy `run` shim — routes through openSession + send + close so
  // handlers that still call `provider.run(prompt, options)` work during
  // the migration window. Removed in Task 24 along with runner-shell.
  const legacyRun = async (prompt: string, options: RunOptions = {}): Promise<RunResult> => {
    const cwd = options.cwd ?? process.cwd();
    const wallClockDeadline = Date.now() + 60 * 60 * 1000;   // 1h default
    const idleStallTimeoutMs = 20 * 60 * 1000;
    const abortCtrl = new AbortController();
    if (options.abortSignal) {
      if (options.abortSignal.aborted) abortCtrl.abort();
      else options.abortSignal.addEventListener('abort', () => abortCtrl.abort(), { once: true });
    }
    const session: Session = provider.openSession({
      cwd,
      wallClockDeadline,
      idleStallTimeoutMs,
      abortSignal: abortCtrl.signal,
      ...(options.bus && { bus: options.bus as unknown as undefined }),
    });
    try {
      const turn = await session.send(prompt, { stageLabel: options.stageLabel ?? 'sub-agent' });
      return assembleRunResult(turn);
    } finally {
      await session.close();
    }
  };

  // Preserve the legacy convention: `name = slot` (not `<provider>:<model>`)
  // so existing call sites (e.g., `p.name === 'standard'`) keep working.
  return { ...provider, name: slot, run: legacyRun };
}
