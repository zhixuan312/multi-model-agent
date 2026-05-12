// makeCodexProvider — v4.4 factory for the codex runtime via the official
// `codex` CLI (codex-cli ≥ 0.130.0). Covers three backends:
//   1. ChatGPT subscription (no baseUrl, no apiKey → OAuth from ~/.codex/auth.json).
//   2. OpenAI proper (baseUrl='https://api.openai.com/v1', apiKeyEnv='OPENAI_API_KEY').
//   3. Any OpenAI-compatible endpoint (baseUrl=<custom>, apiKeyEnv=<custom>).
//
// All three are differentiated by `-c model_providers.X={...}` flags
// constructed in buildCodexCliLaunch. The codex CLI itself owns OAuth
// refresh for path (1) — mma does not parse ~/.codex/auth.json.

import type { Provider, SessionOpts } from '../types/run-result.js';
import type { CodexProviderConfig, ProviderConfig } from '../types/config.js';
import { CodexCliSession } from './codex-cli-session.js';

export function makeCodexProvider(cfg: CodexProviderConfig): Provider {
  return {
    name: `codex:${cfg.model}`,
    config: cfg as unknown as ProviderConfig,
    openSession(opts: SessionOpts) {
      return new CodexCliSession({
        cfg: {
          model: cfg.model,
          ...(cfg.baseUrl && { baseUrl: cfg.baseUrl }),
          ...(cfg.apiKey && { apiKey: cfg.apiKey }),
          ...(cfg.apiKeyEnv && { apiKeyEnv: cfg.apiKeyEnv }),
        },
        opts,
      });
    },
  };
}
