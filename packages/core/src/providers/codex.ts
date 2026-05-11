// makeCodexProvider — v4.4 factory for the Codex provider. Uses the same
// @openai/agents session wrapper as the OpenAI provider; the only
// difference is the underlying OpenAI client (OAuth token + codex
// backend URL instead of an API key against api.openai.com).
//
// Auth precedence:
//   1. cfg.apiKey + cfg.baseUrl, if both provided (non-OAuth use, rare).
//   2. ~/.codex/auth.json OAuth token (Codex CLI subscription); apiKey =
//      access token, baseURL = chatgpt.com/backend-api/codex, with
//      chatgpt-account-id header.
//   3. Constructor throws — codex unavailable, switch tier config.

import OpenAI from 'openai';
import type { Provider, SessionOpts } from '../types/run-result.js';
import type { ProviderConfig } from '../types/config.js';
import { OpenAIAgentSession } from './openai-agent-session.js';
import { getCodexAuth } from '../identity/auth-token-store.js';

export interface CodexProviderConfig {
  type: 'codex';
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export function makeCodexProvider(cfg: CodexProviderConfig): Provider {
  return {
    name: `codex:${cfg.model}`,
    config: cfg as unknown as ProviderConfig,
    openSession(opts: SessionOpts) {
      const oauth = (!cfg.apiKey && !cfg.baseUrl) ? getCodexAuth() : null;
      if (!oauth && !cfg.apiKey) {
        throw new Error(
          'codex provider unavailable: ~/.codex/auth.json not found and no apiKey supplied. ' +
          'Run `codex login`, or switch your tier config away from codex.',
        );
      }
      const client = oauth
        ? new OpenAI({
            apiKey: oauth.accessToken,
            baseURL: 'https://chatgpt.com/backend-api/codex',
            defaultHeaders: { 'chatgpt-account-id': oauth.accountId },
          })
        : new OpenAI({
            apiKey: cfg.apiKey!,
            ...(cfg.baseUrl && { baseURL: cfg.baseUrl }),
          });
      return new OpenAIAgentSession({ client, model: cfg.model, opts });
    },
  };
}
