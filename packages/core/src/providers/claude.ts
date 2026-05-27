// makeClaudeProvider — v4.4 factory for the Claude runtime via
// `@anthropic-ai/claude-agent-sdk`. The `type: 'claude'` config covers
// both Anthropic API and any Anthropic-compatible proxy (set `baseUrl`).
//
// Auth precedence:
//   1. cfg.apiKey (or value resolved from cfg.apiKeyEnv at factory time).
//   2. ~/.claude OAuth (Claude Max subscription) → ANTHROPIC_AUTH_TOKEN.
//   3. Otherwise the SDK reads ANTHROPIC_API_KEY from env itself.

import type { Provider, SessionOpts } from '../types/run-result.js';
import type { ClaudeProviderConfig } from '../types/config.js';
import { ClaudeSession } from './claude-session.js';
import { getClaudeOAuth } from '../identity/claude-oauth.js';

export function makeClaudeProvider(cfg: ClaudeProviderConfig): Provider {
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
        ...(cfg.apiKey && { apiKey: cfg.apiKey }),
        ...(cfg.baseUrl && { baseUrl: cfg.baseUrl }),
        ...(oauthAccessToken && { oauthAccessToken }),
      });
    },
  };
}
