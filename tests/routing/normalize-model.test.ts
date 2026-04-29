import { describe, it, expect } from 'vitest';
import { extractCanonicalModelName, findModelProfile } from '../../packages/core/src/routing/model-profiles.js';

describe('extractCanonicalModelName', () => {
  // ── Locked V3 spec examples (§4.3) ────────────────────────────────────
  // Canonical name = matched profile prefix per plan Task 1 step 4.
  it.each([
    ['us.anthropic.claude-sonnet-4-6-v1:0', 'claude-sonnet'],
    ['vertex-ai/claude-sonnet-4-6@2024-10-22', 'claude-sonnet'],
    ['azure/openai/gpt-5-2025-09-15', 'gpt-5'],
    ['openrouter/meta-llama/llama-4-instruct', 'llama-4'],
    ['groq/mixtral-8x7b-instruct-32768', 'custom'],
    ['bedrock-meta-llama-3-70b-instruct', 'custom'],
    ['gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro'],
    ['ollama/dolphin-mixtral', 'dolphin'],
    ['acme-corp-finetuned-claude', 'custom'],
    ['my-internal-model-v3', 'custom'],
  ])('normalizes locked V3 example %s to %s', (input, output) => {
    expect(extractCanonicalModelName(input)).toBe(output);
  });

  it('preserves registry-backed base variants via Step 2.5 first pass', () => {
    // deepseek-v4-base has no dedicated profile; Step 2.5 fails,
    // Step 2 strips -base, Step 3 matches deepseek profile
    expect(extractCanonicalModelName('deepseek-v4-base')).toBe('deepseek');
  });

  it('strips base variant, falls back to parent profile via Step 2→3', () => {
    expect(extractCanonicalModelName('claude-sonnet-4-6-base')).toBe('claude-sonnet');
  });

  it.each(['', '   ', 'model with spaces', 'モデル', 'a'.repeat(121)])('maps invalid or non-registry input %j to custom', input => {
    expect(extractCanonicalModelName(input)).toBe('custom');
  });

  // ── Bedrock prefix variants ──────────────────────────────────────────
  it('strips bedrock. prefix, normalizes to canonical', () => {
    expect(extractCanonicalModelName('bedrock.claude-haiku-4-5')).toBe('claude-haiku');
  });

  it('strips bedrock/ prefix, normalizes to canonical', () => {
    expect(extractCanonicalModelName('bedrock/claude-sonnet-4-5')).toBe('claude-sonnet');
  });

  it('strips aws. prefix, normalizes to canonical', () => {
    expect(extractCanonicalModelName('aws.claude-opus-4-7')).toBe('claude-opus');
  });

  it('strips anthropic. prefix + version suffix, normalizes to canonical', () => {
    expect(extractCanonicalModelName('anthropic.claude-haiku-4-5-v1:0')).toBe('claude-haiku');
  });

  it('collapses compound prefix bedrock.anthropic.', () => {
    expect(extractCanonicalModelName('bedrock.anthropic.claude-haiku-4-5')).toBe('claude-haiku');
  });

  // ── Vertex prefix variants ───────────────────────────────────────────
  it('strips vertex/ prefix, normalizes to canonical', () => {
    expect(extractCanonicalModelName('vertex/claude-haiku-4-5')).toBe('claude-haiku');
  });

  it('strips vertex_ai/ prefix, normalizes to canonical', () => {
    expect(extractCanonicalModelName('vertex_ai/claude-sonnet-4-5')).toBe('claude-sonnet');
  });

  // ── Azure prefix variants ────────────────────────────────────────────
  it('strips azure/ prefix', () => {
    expect(extractCanonicalModelName('azure/gpt-5.5')).toBe('gpt-5.5');
  });

  it('strips azure_openai/ prefix', () => {
    expect(extractCanonicalModelName('azure_openai/gpt-5.5')).toBe('gpt-5.5');
  });

  // ── Bare names normalize to matched profile prefix ────────────────────
  it('normalizes bare claude name to its profile prefix', () => {
    expect(extractCanonicalModelName('claude-haiku-4-5')).toBe('claude-haiku');
  });

  it('passes bare gpt name through unchanged', () => {
    expect(extractCanonicalModelName('gpt-5.5')).toBe('gpt-5.5');
  });

  it('normalizes MiniMax-M2.7 to MiniMax-M2 profile prefix', () => {
    expect(extractCanonicalModelName('MiniMax-M2.7')).toBe('MiniMax-M2');
  });

  it('passes deepseek-v4-pro through unchanged (its own profile prefix)', () => {
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
    expect(extractCanonicalModelName('BEDROCK.claude-haiku-4-5')).toBe('claude-haiku');
  });

  it('matches prefix case-insensitively (Vertex/)', () => {
    expect(extractCanonicalModelName('Vertex/claude-haiku-4-5')).toBe('claude-haiku');
  });

  it('preserves model name case after prefix strip', () => {
    expect(extractCanonicalModelName('bedrock.MiniMax-M2.7')).toBe('MiniMax-M2');
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
