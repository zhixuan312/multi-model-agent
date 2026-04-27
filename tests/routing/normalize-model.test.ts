import { describe, it, expect } from 'vitest';
import { extractCanonicalModelName, findModelProfile } from '../../packages/core/src/routing/model-profiles.js';

describe('extractCanonicalModelName', () => {
  // ── Bedrock prefix variants ──────────────────────────────────────────
  it('strips bedrock. prefix', () => {
    expect(extractCanonicalModelName('bedrock.claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('strips bedrock/ prefix', () => {
    expect(extractCanonicalModelName('bedrock/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });

  it('strips aws. prefix', () => {
    expect(extractCanonicalModelName('aws.claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('strips anthropic. prefix + version suffix', () => {
    expect(extractCanonicalModelName('anthropic.claude-haiku-4-5-v1:0')).toBe('claude-haiku-4-5');
  });

  it('collapses compound prefix bedrock.anthropic.', () => {
    expect(extractCanonicalModelName('bedrock.anthropic.claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  // ── Vertex prefix variants ───────────────────────────────────────────
  it('strips vertex/ prefix', () => {
    expect(extractCanonicalModelName('vertex/claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('strips vertex_ai/ prefix', () => {
    expect(extractCanonicalModelName('vertex_ai/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });

  // ── Azure prefix variants ────────────────────────────────────────────
  it('strips azure/ prefix', () => {
    expect(extractCanonicalModelName('azure/gpt-5.5')).toBe('gpt-5.5');
  });

  it('strips azure_openai/ prefix', () => {
    expect(extractCanonicalModelName('azure_openai/gpt-5.5')).toBe('gpt-5.5');
  });

  // ── Bare names pass through unchanged ─────────────────────────────────
  it('passes bare claude name through unchanged', () => {
    expect(extractCanonicalModelName('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('passes bare gpt name through unchanged', () => {
    expect(extractCanonicalModelName('gpt-5.5')).toBe('gpt-5.5');
  });

  it('passes MiniMax-M2.7 through unchanged', () => {
    expect(extractCanonicalModelName('MiniMax-M2.7')).toBe('MiniMax-M2.7');
  });

  it('passes deepseek-v4-pro through unchanged', () => {
    expect(extractCanonicalModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  // ── Idempotence ──────────────────────────────────────────────────────
  it('is idempotent for bedrock.claude-haiku-4-5', () => {
    const once = extractCanonicalModelName('bedrock.claude-haiku-4-5');
    const twice = extractCanonicalModelName(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for vertex_ai/anthropic.claude-sonnet-4-5-v1:0', () => {
    const once = extractCanonicalModelName('vertex_ai/anthropic.claude-sonnet-4-5-v1:0');
    const twice = extractCanonicalModelName(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for bare gpt-5.5', () => {
    const once = extractCanonicalModelName('gpt-5.5');
    const twice = extractCanonicalModelName(once);
    expect(twice).toBe(once);
  });

  // ── Case-insensitivity of prefix ─────────────────────────────────────
  it('matches prefix case-insensitively (BEDROCK.)', () => {
    expect(extractCanonicalModelName('BEDROCK.claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('matches prefix case-insensitively (Vertex/)', () => {
    expect(extractCanonicalModelName('Vertex/claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('preserves model name case after prefix strip', () => {
    expect(extractCanonicalModelName('bedrock.MiniMax-M2.7')).toBe('MiniMax-M2.7');
  });
});

describe('findModelProfile with vendor-prefixed names', () => {
  it('matches bedrock.claude-haiku-4-5 to claude-haiku profile', () => {
    const profile = findModelProfile('bedrock.claude-haiku-4-5');
    expect(profile.prefix).toBe('claude-haiku');
    expect(profile.inputCostPerMTok).toBeGreaterThan(0);
    expect(profile.outputCostPerMTok).toBeGreaterThan(0);
  });

  it('matches bedrock/claude-sonnet-4-5 to claude-sonnet profile', () => {
    const profile = findModelProfile('bedrock/claude-sonnet-4-5');
    expect(profile.prefix).toBe('claude-sonnet');
  });

  it('matches vertex/claude-haiku-4-5 to claude-haiku profile', () => {
    const profile = findModelProfile('vertex/claude-haiku-4-5');
    expect(profile.prefix).toBe('claude-haiku');
  });

  it('matches azure/gpt-5.5 to gpt-5.5 profile', () => {
    const profile = findModelProfile('azure/gpt-5.5');
    expect(profile.prefix).toBe('gpt-5.5');
  });

  it('falls to DEFAULT_PROFILE for completely unknown model', () => {
    const profile = findModelProfile('unknown-model-xyz');
    expect(profile.prefix).toBe('');
  });
});
