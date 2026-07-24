import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '../../packages/core/src/types.js';
import {
  resolveConfiguredApiKey,
  resolveConfiguredAuthMode,
  classifyAuthFailure,
} from '../../packages/core/src/providers/provider-factory.js';

describe('provider-factory auth helpers', () => {
  const codexEnvConfig: AgentConfig = {
    type: 'codex',
    model: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  };

  const claudeInlineConfig: AgentConfig = {
    type: 'claude',
    model: 'claude-opus-4-8',
    apiKey: 'sk-ant-inline',
  };

  it('resolveConfiguredApiKey prefers inline apiKey over apiKeyEnv', () => {
    expect(resolveConfiguredApiKey(
      { ...claudeInlineConfig, apiKeyEnv: 'ANTHROPIC_API_KEY' },
      { ANTHROPIC_API_KEY: 'env-value' },
    )).toBe('sk-ant-inline');
  });

  it('resolveConfiguredApiKey reads apiKeyEnv from the provided env bag', () => {
    expect(resolveConfiguredApiKey(
      codexEnvConfig,
      { OPENAI_API_KEY: 'sk-openai-env' },
    )).toBe('sk-openai-env');
  });

  it('resolveConfiguredAuthMode returns api-key when apiKeyEnv resolves', () => {
    expect(resolveConfiguredAuthMode(
      codexEnvConfig,
      { OPENAI_API_KEY: 'sk-openai-env' },
    )).toBe('api-key');
  });

  it('resolveConfiguredAuthMode returns oauth when neither inline nor env-backed key exists', () => {
    expect(resolveConfiguredAuthMode(
      codexEnvConfig,
      {},
    )).toBe('oauth');
  });

  it('classifyAuthFailure returns missing_credentials with tier/provider in the message', () => {
    expect(classifyAuthFailure({
      tier: 'complex',
      provider: 'claude',
      errorCode: 'sdk_execution_error',
      errorMessage: 'No API key found for Anthropic and no OAuth token is available',
    })).toEqual({
      code: 'missing_credentials',
      message: 'complex tier claude provider is missing credentials',
    });
  });

  it('classifyAuthFailure returns invalid_api_key with tier/provider in the message', () => {
    expect(classifyAuthFailure({
      tier: 'standard',
      provider: 'codex',
      errorCode: 'turn_failed',
      errorMessage: '401 Unauthorized: Invalid API key provided',
    })).toEqual({
      code: 'invalid_api_key',
      message: 'standard tier codex provider rejected the configured API key',
    });
  });

  it('classifyAuthFailure returns null for non-auth runtime failures', () => {
    expect(classifyAuthFailure({
      tier: 'standard',
      provider: 'codex',
      errorCode: 'turn_failed',
      errorMessage: 'context window exhausted',
    })).toBeNull();
  });
});
