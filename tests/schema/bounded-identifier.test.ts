import { describe, it, expect } from 'vitest';
import { BoundedIdentifier } from '../../packages/core/src/telemetry/types.js';

describe('BoundedIdentifier', () => {
  it('accepts canonical Anthropic model IDs', () => {
    expect(BoundedIdentifier.safeParse('claude-sonnet-4-5').success).toBe(true);
    expect(BoundedIdentifier.safeParse('claude-opus-4-7').success).toBe(true);
  });

  it('accepts OpenAI models including o-series', () => {
    expect(BoundedIdentifier.safeParse('gpt-5.5').success).toBe(true);
    expect(BoundedIdentifier.safeParse('o1-mini').success).toBe(true);
    expect(BoundedIdentifier.safeParse('o3').success).toBe(true);
  });

  it('accepts vendor-prefixed model IDs', () => {
    expect(BoundedIdentifier.safeParse('bedrock/anthropic.claude-3-haiku-20240307-v1:0').success).toBe(true);
    expect(BoundedIdentifier.safeParse('meta-llama/Llama-4-Maverick-17B-128E-Instruct').success).toBe(true);
  });

  it('accepts Ollama-style colon-tagged IDs', () => {
    expect(BoundedIdentifier.safeParse('llama2:7b').success).toBe(true);
    expect(BoundedIdentifier.safeParse('qwen2.5:14b').success).toBe(true);
  });

  it('accepts custom finetune and proxy alias names', () => {
    expect(BoundedIdentifier.safeParse('my-internal-finetune-v3.2').success).toBe(true);
    expect(BoundedIdentifier.safeParse('gpt-4-via-corp-gateway').success).toBe(true);
  });

  it('accepts client identifiers and MCP tool names', () => {
    expect(BoundedIdentifier.safeParse('claude-code').success).toBe(true);
    expect(BoundedIdentifier.safeParse('zed-ai').success).toBe(true);
    expect(BoundedIdentifier.safeParse('mcp__github__create_issue').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(BoundedIdentifier.safeParse('').success).toBe(false);
  });

  it('rejects strings longer than 120 characters', () => {
    expect(BoundedIdentifier.safeParse('a'.repeat(121)).success).toBe(false);
  });

  it('rejects strings with spaces', () => {
    expect(BoundedIdentifier.safeParse('model with spaces').success).toBe(false);
  });

  it('rejects SQL-injection-shaped input', () => {
    expect(BoundedIdentifier.safeParse(`claude'; DROP TABLE installs;--`).success).toBe(false);
  });

  it('rejects email-shaped input (@ not in charset)', () => {
    expect(BoundedIdentifier.safeParse('model@email.com').success).toBe(false);
  });

  it('rejects script-injection input', () => {
    expect(BoundedIdentifier.safeParse('<script>alert(1)</script>').success).toBe(false);
  });

  it('rejects null bytes', () => {
    expect(BoundedIdentifier.safeParse('\0claude').success).toBe(false);
  });
});
