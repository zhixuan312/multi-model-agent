import { describe, it, expect } from 'vitest';
import { stripThinkingTags } from '../../packages/core/src/runners/openai-runner.js';

describe('stripThinkingTags', () => {
  it('returns plain text unchanged', () => {
    expect(stripThinkingTags('Hello world')).toBe('Hello world');
  });

  it('removes a single think block', () => {
    const input = '<think>I should say hi</think>Hello';
    expect(stripThinkingTags(input)).toBe('Hello');
  });

  it('removes multi-line think blocks', () => {
    const input = '<think>\nLet me think step by step.\n1. First...\n2. Second...\n</think>\nFinal answer';
    expect(stripThinkingTags(input)).toBe('Final answer');
  });

  it('removes multiple think blocks', () => {
    const input = '<think>first thought</think>part one<think>second thought</think>part two';
    expect(stripThinkingTags(input)).toBe('part onepart two');
  });

  it('handles think blocks with extra whitespace after', () => {
    const input = '<think>reasoning</think>\n\n\nActual response';
    expect(stripThinkingTags(input)).toBe('Actual response');
  });

  it('is non-greedy and does not eat content between blocks', () => {
    const input = '<think>a</think>middle<think>b</think>end';
    expect(stripThinkingTags(input)).toBe('middleend');
  });

  it('is case-insensitive on the tag name', () => {
    const input = '<THINK>thinking</THINK>visible';
    expect(stripThinkingTags(input)).toBe('visible');
  });

  it('leaves unrelated angle-bracket content alone', () => {
    const input = 'Here is some <code>x + y</code> and a <think>aside</think>result';
    expect(stripThinkingTags(input)).toBe('Here is some <code>x + y</code> and a result');
  });

  it('handles empty input', () => {
    expect(stripThinkingTags('')).toBe('');
  });

  it('returns a diagnostic marker when the entire output is a single think block', () => {
    const result = stripThinkingTags('<think>only thoughts</think>');
    expect(result).toBe(
      '[model final message contained only <think>...</think> reasoning, no plain-text answer]',
    );
  });

  it('returns a diagnostic marker when multiple think blocks fill the entire output', () => {
    const result = stripThinkingTags('<think>first</think>\n<think>second</think>');
    expect(result).toBe(
      '[model final message contained only <think>...</think> reasoning, no plain-text answer]',
    );
  });
});
