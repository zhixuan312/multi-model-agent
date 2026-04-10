import { describe, it, expect } from 'vitest';
import { getBaseCapabilities } from '@scope/multi-model-agent-core/routing/capabilities';
import type { ProviderConfig } from '@scope/multi-model-agent-core';

describe('getBaseCapabilities', () => {
  describe('file capabilities (every provider type)', () => {
    it('returns file tools for codex', () => {
      const caps = getBaseCapabilities({ type: 'codex', model: 'gpt-5-codex' });
      expect(caps).toEqual(expect.arrayContaining(['file_read', 'file_write', 'grep', 'glob']));
    });

    it('returns file tools for claude', () => {
      const caps = getBaseCapabilities({ type: 'claude', model: 'claude-opus-4-6' });
      expect(caps).toEqual(expect.arrayContaining(['file_read', 'file_write', 'grep', 'glob']));
    });

    it('returns file tools for openai-compatible', () => {
      const caps = getBaseCapabilities({
        type: 'openai-compatible',
        model: 'MiniMax-M2',
        baseUrl: 'https://api.example.com/v1',
      });
      expect(caps).toEqual(expect.arrayContaining(['file_read', 'file_write', 'grep', 'glob']));
    });
  });

  describe('web capabilities', () => {
    it('auto-enables web_search for codex when hostedTools is undefined', () => {
      const caps = getBaseCapabilities({ type: 'codex', model: 'gpt-5-codex' });
      expect(caps).toContain('web_search');
    });

    it('respects explicit empty hostedTools for codex as an opt-out', () => {
      const caps = getBaseCapabilities({
        type: 'codex',
        model: 'gpt-5-codex',
        hostedTools: [],
      });
      expect(caps).not.toContain('web_search');
    });

    it('respects explicit hostedTools list without web_search as an opt-out', () => {
      const caps = getBaseCapabilities({
        type: 'codex',
        model: 'gpt-5-codex',
        hostedTools: ['image_generation'],
      });
      expect(caps).not.toContain('web_search');
    });

    it('includes web_search and web_fetch for claude unconditionally', () => {
      const caps = getBaseCapabilities({ type: 'claude', model: 'claude-opus-4-6' });
      expect(caps).toContain('web_search');
      expect(caps).toContain('web_fetch');
    });

    it('does not include web_fetch for codex', () => {
      const caps = getBaseCapabilities({ type: 'codex', model: 'gpt-5-codex' });
      expect(caps).not.toContain('web_fetch');
    });

    it('does not auto-enable web_search for openai-compatible', () => {
      const caps = getBaseCapabilities({
        type: 'openai-compatible',
        model: 'MiniMax-M2',
        baseUrl: 'https://api.example.com/v1',
      });
      expect(caps).not.toContain('web_search');
      expect(caps).not.toContain('web_fetch');
    });

    it('merges web_search from hostedTools for openai-compatible', () => {
      const caps = getBaseCapabilities({
        type: 'openai-compatible',
        model: 'gpt-5',
        baseUrl: 'https://api.openai.com/v1',
        hostedTools: ['web_search'],
      });
      expect(caps).toContain('web_search');
    });

    it('ignores image_generation and code_interpreter (not in routing vocabulary)', () => {
      const caps = getBaseCapabilities({
        type: 'openai-compatible',
        model: 'gpt-5',
        baseUrl: 'https://api.openai.com/v1',
        hostedTools: ['image_generation', 'code_interpreter'],
      });
      expect(caps).not.toContain('image_generation' as never);
      expect(caps).not.toContain('code_interpreter' as never);
    });

    it('deduplicates when hostedTools duplicates a base capability', () => {
      const caps = getBaseCapabilities({
        type: 'claude',
        model: 'claude-opus-4-6',
        hostedTools: ['web_search'],
      });
      const webSearchCount = caps.filter((c) => c === 'web_search').length;
      expect(webSearchCount).toBe(1);
    });
  });

  describe('shell capability (sandbox-gated)', () => {
    it('does not include shell for codex by default (sandboxPolicy undefined)', () => {
      const caps = getBaseCapabilities({ type: 'codex', model: 'gpt-5-codex' });
      expect(caps).not.toContain('shell');
    });

    it('does not include shell for codex with explicit sandboxPolicy cwd-only', () => {
      const caps = getBaseCapabilities({
        type: 'codex',
        model: 'gpt-5-codex',
        sandboxPolicy: 'cwd-only',
      });
      expect(caps).not.toContain('shell');
    });

    it('includes shell for codex when sandboxPolicy is explicitly none', () => {
      const caps = getBaseCapabilities({
        type: 'codex',
        model: 'gpt-5-codex',
        sandboxPolicy: 'none',
      });
      expect(caps).toContain('shell');
    });

    it('does not include shell for claude by default', () => {
      const caps = getBaseCapabilities({ type: 'claude', model: 'claude-opus-4-6' });
      expect(caps).not.toContain('shell');
    });

    it('includes shell for claude when sandboxPolicy is explicitly none', () => {
      const caps = getBaseCapabilities({
        type: 'claude',
        model: 'claude-opus-4-6',
        sandboxPolicy: 'none',
      });
      expect(caps).toContain('shell');
    });

    it('does not include shell for openai-compatible by default', () => {
      const caps = getBaseCapabilities({
        type: 'openai-compatible',
        model: 'MiniMax-M2',
        baseUrl: 'https://api.example.com/v1',
      });
      expect(caps).not.toContain('shell');
    });

    it('includes shell for openai-compatible when sandboxPolicy is explicitly none', () => {
      const caps = getBaseCapabilities({
        type: 'openai-compatible',
        model: 'MiniMax-M2',
        baseUrl: 'https://api.example.com/v1',
        sandboxPolicy: 'none',
      });
      expect(caps).toContain('shell');
    });
  });
});