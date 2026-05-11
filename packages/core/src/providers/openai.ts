// makeOpenAIProvider — v4.4 factory for the OpenAI provider. Uses
// @openai/agents (via openai-agent-session.ts) with a per-session
// OpenAIProvider bound to a freshly-constructed OpenAI client. No
// global setDefaultOpenAIClient — each session has its own client.

import OpenAI from 'openai';
import type { Provider, SessionOpts } from '../types/run-result.js';
import type { ProviderConfig } from '../types/config.js';
import { OpenAIAgentSession } from './openai-agent-session.js';

export interface OpenAIProviderConfig {
  type: 'openai-compatible';
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export function makeOpenAIProvider(cfg: OpenAIProviderConfig): Provider {
  return {
    name: `openai:${cfg.model}`,
    config: cfg as unknown as ProviderConfig,
    openSession(opts: SessionOpts) {
      const client = new OpenAI({
        apiKey: cfg.apiKey || 'not-needed',
        ...(cfg.baseUrl && { baseURL: cfg.baseUrl }),
      });
      return new OpenAIAgentSession({ client, model: cfg.model, opts });
    },
  };
}
