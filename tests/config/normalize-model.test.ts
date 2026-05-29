import { describe, it, expect } from 'bun:test';
import { extractCanonicalModelName, findModelProfile } from '../../packages/core/src/config/model-profile-registry.js';

// 4.0.3+: extractCanonicalModelName preserves model + version (e.g.
// `claude-opus-4-7`, not the prefix `claude-opus`). Date-only suffixes
// (`@YYYY-MM-DD`, `-YYYY-MM-DD`, `-YYYYMMDD`, `-latest`) are stripped.
// Vendor namespaces (`bedrock.`, `vertex_ai/`, `aws.`, `azure/`, etc.)
// are stripped. The matched-prefix collapse only happens as a fallback
// when no profile matches the date-stripped form, in which case we fall
// through to TRAILING_MARKERS-based stripping (and ultimately 'custom').
describe('extractCanonicalModelName', () => {
  it.each([
    // wrapper-boundary truncation: ':0' is a deployment-version separator,
    // '-v1' is a provisioning-version marker. Both stripped.
    ['us.anthropic.claude-sonnet-4-6-v1:0', 'claude-sonnet-4-6'],
    ['vertex-ai/claude-sonnet-4-6@2024-10-22', 'claude-sonnet-4-6'],
    ['azure/openai/gpt-5-2025-09-15', 'gpt-5'],
    ['openrouter/meta-llama/llama-4-instruct', 'llama-4-instruct'],
    ['groq/mixtral-8x7b-instruct-32768', 'custom'],
    // 4.0.3+ best-effort substring match: bedrock- prefix is stripped,
    // then llama-3 prefix recognized in the remainder. Telemetry now
    // attributes this as an llama family run instead of 'custom'.
    ['bedrock-meta-llama-3-70b-instruct', 'llama-3-70b-instruct'],
    ['gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-05-06'],
    ['ollama/dolphin-mixtral', 'dolphin-mixtral'],
    // Substring extraction recognizes the trailing 'claude' as a known
    // profile prefix. Without version info we surface the bare family.
    ['acme-corp-finetuned-claude', 'claude'],
    ['my-internal-model-v3', 'custom'],
  ])('preserves model+version for %s → %s', (input, output) => {
    expect(extractCanonicalModelName(input)).toBe(output);
  });

  it('keeps registry-backed base variants in the canonical form (no prefix collapse)', () => {
    expect(extractCanonicalModelName('deepseek-v4-base')).toBe('deepseek-v4-base');
  });

  it('keeps base variant in canonical (no prefix collapse to claude-sonnet)', () => {
    expect(extractCanonicalModelName('claude-sonnet-4-6-base')).toBe('claude-sonnet-4-6-base');
  });

  it.each(['', '   ', 'model with spaces', 'モデル', 'a'.repeat(121)])('maps invalid or non-registry input %j to custom', input => {
    expect(extractCanonicalModelName(input)).toBe('custom');
  });

  // ── Bedrock prefix variants ──────────────────────────────────────────
  it('strips bedrock. prefix, preserves model+version', () => {
    expect(extractCanonicalModelName('bedrock.claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('strips bedrock/ prefix, preserves model+version', () => {
    expect(extractCanonicalModelName('bedrock/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });

  it('strips aws. prefix, preserves model+version', () => {
    expect(extractCanonicalModelName('aws.claude-opus-4-7')).toBe('claude-opus-4-7');
  });

  it('strips anthropic. prefix + provisioning -v1 + :N boundary', () => {
    expect(extractCanonicalModelName('anthropic.claude-haiku-4-5-v1:0')).toBe('claude-haiku-4-5');
  });

  it('collapses compound prefix bedrock.anthropic., preserves model+version', () => {
    expect(extractCanonicalModelName('bedrock.anthropic.claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  // ── Vertex prefix variants ───────────────────────────────────────────
  it('strips vertex/ prefix, preserves model+version', () => {
    expect(extractCanonicalModelName('vertex/claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('strips vertex_ai/ prefix, preserves model+version', () => {
    expect(extractCanonicalModelName('vertex_ai/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });

  // ── Azure prefix variants ────────────────────────────────────────────
  it('strips azure/ prefix', () => {
    expect(extractCanonicalModelName('azure/gpt-5.5')).toBe('gpt-5.5');
  });

  it('strips azure_openai/ prefix', () => {
    expect(extractCanonicalModelName('azure_openai/gpt-5.5')).toBe('gpt-5.5');
  });

  // ── Bare names preserve model+version ────────────────────────────────
  it('preserves bare claude name with full version', () => {
    expect(extractCanonicalModelName('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('passes bare gpt name through unchanged', () => {
    expect(extractCanonicalModelName('gpt-5.5')).toBe('gpt-5.5');
  });

  it('preserves MiniMax-M2.7 with full version', () => {
    expect(extractCanonicalModelName('MiniMax-M2.7')).toBe('MiniMax-M2.7');
  });

  it('passes deepseek-v4-pro through unchanged', () => {
    expect(extractCanonicalModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  // ── Date-suffix stripping ────────────────────────────────────────────
  it('strips @YYYY-MM-DD release stamp', () => {
    expect(extractCanonicalModelName('claude-opus-4-1@2025-07-15')).toBe('claude-opus-4-1');
  });

  it('strips -YYYYMMDD compact date suffix', () => {
    expect(extractCanonicalModelName('claude-3-opus-20240229')).toBe('claude-3-opus');
  });

  it('strips -latest sentinel', () => {
    expect(extractCanonicalModelName('claude-opus-latest')).toBe('claude-opus');
  });

  // ── Idempotence ──────────────────────────────────────────────────────
  it('is idempotent for bedrock.claude-haiku-4-5', () => {
    const once = extractCanonicalModelName('bedrock.claude-haiku-4-5');
    const twice = extractCanonicalModelName(once);
    expect(twice).toBe(once);
  });

  it('is idempotent for vertex_ai/anthropic.claude-sonnet-4-5-v1:0', () => {
    const once = extractCanonicalModelName('vertex_ai/anthropic.claude-sonnet-4-5-v1:0');
    expect(once).toBe('claude-sonnet-4-5');
    const twice = extractCanonicalModelName(once);
    expect(twice).toBe(once);
  });

  // ── Best-effort substring extraction (4.0.3+) ───────────────────────
  // Some routers/proxies sandwich the canonical id between random tokens.
  // We do our best to extract the model name when a known prefix appears.
  it('extracts canonical id from arbitrary wrapper (id sandwiched in random tokens)', () => {
    expect(extractCanonicalModelName('my_router_42_claude-opus-4-7_xyz')).toBe('claude-opus-4-7');
  });

  it('extracts canonical id when wrapped with @-version tag', () => {
    expect(extractCanonicalModelName('proxy:claude-opus-4-7@v3')).toBe('claude-opus-4-7');
  });

  it('strips trailing-noise word "suffix"', () => {
    expect(extractCanonicalModelName('claude-sonnet-4-6-suffix')).toBe('claude-sonnet-4-6');
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

  // Regression: bare names with non-canonical casing on the prefix portion
  // (e.g. user typo `claude-Haiku-4-5`) used to pass the case-insensitive
  // prefix check but be returned verbatim, producing duplicate model rows
  // in telemetry rollups. Now the canonical prefix casing is spliced in.
  it('canonicalizes prefix casing for bare claude-Haiku-4-5', () => {
    expect(extractCanonicalModelName('claude-Haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('canonicalizes prefix casing for bare CLAUDE-OPUS-4-7', () => {
    expect(extractCanonicalModelName('CLAUDE-OPUS-4-7')).toBe('claude-opus-4-7');
  });

  it('canonicalizes prefix casing after vendor strip', () => {
    expect(extractCanonicalModelName('bedrock.claude-Haiku-4-5')).toBe('claude-haiku-4-5');
  });
});

// findModelProfile still uses prefix collapse for cost lookup — the
// canonical name is for wire display, the profile prefix is for rate
// resolution. Both functions are intentionally distinct concerns.
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
