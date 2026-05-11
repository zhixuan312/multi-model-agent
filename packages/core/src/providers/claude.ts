// makeClaudeProvider — factory for the v4.4 Claude provider that opens
// sessions through `@anthropic-ai/claude-agent-sdk`. Auth precedence:
//   1. cfg.apiKey, if provided (exported as ANTHROPIC_API_KEY for the SDK).
//   2. ~/.claude/keychain OAuth (Claude Max subscription), exported as
//      ANTHROPIC_AUTH_TOKEN for the SDK to read.
//   3. Otherwise the SDK reads ANTHROPIC_API_KEY from env itself.

import type { Provider, SessionOpts } from '../types/run-result.js';
import type { ProviderConfig } from '../types/config.js';
import { ClaudeSession } from './claude-session.js';
import { getClaudeOAuth } from '../identity/auth-token-store.js';

export interface ClaudeProviderConfig {
  type: 'claude' | 'claude-compatible';
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export function makeClaudeProvider(cfg: ClaudeProviderConfig): Provider {
  return {
    name: `claude:${cfg.model}`,
    config: cfg as unknown as ProviderConfig,
    openSession(opts: SessionOpts) {
      let oauthAccessToken: string | undefined;
      if (cfg.apiKey) {
        process.env.ANTHROPIC_API_KEY = cfg.apiKey;
      } else if (cfg.type === 'claude') {
        const oauth = getClaudeOAuth();
        if (oauth) oauthAccessToken = oauth.accessToken;
      }
      return new ClaudeSession({ model: cfg.model, opts, ...(oauthAccessToken && { oauthAccessToken }) });
    },
  };
}
