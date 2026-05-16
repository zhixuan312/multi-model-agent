// makeClaudeProvider — v4.4 factory for the Claude runtime via
// `@anthropic-ai/claude-agent-sdk`. The `type: 'claude'` config covers
// both Anthropic API and any Anthropic-compatible proxy (set `baseUrl`).
//
// Auth precedence:
//   1. cfg.apiKey (or value resolved from cfg.apiKeyEnv at factory time).
//   2. ~/.claude OAuth (Claude Max subscription) → ANTHROPIC_AUTH_TOKEN.
//   3. Otherwise the SDK reads ANTHROPIC_API_KEY from env itself.

import type { Provider, SessionOpts } from '../types/run-result.js';
import type { ClaudeProviderConfig, ProviderConfig } from '../types/config.js';
import { ClaudeSession } from './claude-session.js';
import { getClaudeOAuth } from '../identity/auth-token-store.js';

export function makeClaudeProvider(cfg: ClaudeProviderConfig): Provider {
  return {
    name: `claude:${cfg.model}`,
    config: cfg,
    openSession(opts: SessionOpts) {
      let oauthAccessToken: string | undefined;
      if (cfg.apiKey) {
        process.env.ANTHROPIC_API_KEY = cfg.apiKey;
      } else if (!cfg.baseUrl) {
        // Only attempt OAuth when targeting the default Anthropic backend.
        // For an Anthropic-compatible proxy, the operator MUST supply apiKey.
        const oauth = getClaudeOAuth();
        if (oauth) oauthAccessToken = oauth.accessToken;
      }
      if (cfg.baseUrl) {
        // The Anthropic SDK reads ANTHROPIC_BASE_URL from env.
        process.env.ANTHROPIC_BASE_URL = cfg.baseUrl;
      }
      return new ClaudeSession({ model: cfg.model, opts, ...(oauthAccessToken && { oauthAccessToken }) });
    },
  };
}
