// makeClaudeProvider — v4.4 factory for the Claude runtime via
// `@anthropic-ai/claude-agent-sdk`. The `type: 'claude'` config covers
// both Anthropic API and any Anthropic-compatible proxy (set `baseUrl`).
//
// Auth precedence:
//   1. cfg.apiKey (or value resolved from cfg.apiKeyEnv at factory time).
//      With a cfg.baseUrl set it is sent as BOTH ANTHROPIC_AUTH_TOKEN
//      (Authorization: Bearer — Ollama Cloud, z.ai, DeepSeek, Kimi, MiniMax)
//      and ANTHROPIC_API_KEY (x-api-key — gateways fronting api.anthropic.com),
//      so any Anthropic-compatible endpoint finds the header it expects.
//      Without a baseUrl it goes to api.anthropic.com as ANTHROPIC_API_KEY only.
//      Either way an inherited ANTHROPIC_* value is cleared first.
//   2. ~/.claude OAuth (Claude Max subscription) → ANTHROPIC_AUTH_TOKEN.
//   3. Otherwise the SDK reads ANTHROPIC_API_KEY from env itself.

import type { Provider, SessionOpts } from '../types/run-result.js';
import type { ClaudeProviderConfig } from '../types/config.js';
import { ClaudeSession } from './claude-session.js';
import { getClaudeOAuth } from '../identity/claude-oauth.js';
import { resolveEffort } from './effort.js';

export function makeClaudeProvider(cfg: ClaudeProviderConfig): Provider {
  // Undefined for models with no effort knob (e.g. a GLM/Kimi endpoint behind
  // the Anthropic wire protocol) — the session then sends no effort option.
  const effort = resolveEffort(cfg.model, cfg.effort);
  return {
    name: `claude:${cfg.model}`,
    config: cfg,
    openSession(opts: SessionOpts) {
      let oauthAccessToken: string | undefined;
      if (!cfg.apiKey && !cfg.baseUrl) {
        const oauth = getClaudeOAuth();
        if (oauth) oauthAccessToken = oauth.accessToken;
      }
      return new ClaudeSession({
        model: cfg.model,
        opts,
        ...(effort && { effort }),
        ...(cfg.apiKey && { apiKey: cfg.apiKey }),
        ...(cfg.baseUrl && { baseUrl: cfg.baseUrl }),
        ...(oauthAccessToken && { oauthAccessToken }),
      });
    },
  };
}
