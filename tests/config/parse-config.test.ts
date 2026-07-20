import { describe, it, expect } from 'vitest';
import { parseConfig } from '@zhixuan92/multi-model-agent-core/config/schema';

const minimalAgentConfig = {
  type: 'codex' as const,
  model: 'test-model',
  baseUrl: 'https://test.example.com/v1',
};

describe('parseConfig', () => {
  it('parses valid minimal config with agents', () => {
    const result = parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
    });
    expect(result.agents.standard.model).toBe('test-model');
  });

  it('parses valid full config', () => {
    const input = {
      agents: {
        standard: { type: 'claude', model: 'claude-sonnet-4-6' },
        complex: { type: 'codex', model: 'gpt-5', baseUrl: 'https://api.example.com' },
      },
    };
    const result = parseConfig(input);
    expect(result.agents.complex.model).toBe('gpt-5');
  });

  it('accepts diagnostics.log enabled without logDir', () => {
    const result = parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
      diagnostics: { log: true },
    });
    expect(result.diagnostics).toEqual({ log: true });
  });

  it('accepts diagnostics.log with diagnostics.logDir', () => {
    const result = parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
      diagnostics: { log: true, logDir: '/tmp/foo' },
    });
    expect(result.diagnostics).toEqual({ log: true, logDir: '/tmp/foo' });
  });

  it('rejects diagnostics.log when it is not a boolean', () => {
    expect(() => parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
      diagnostics: { log: 'yes' as any },
    })).toThrow();
  });

  it('throws on invalid agent type', () => {
    expect(() => parseConfig({
      agents: {
        standard: { type: 'unknown', model: 'x' } as any,
        complex: minimalAgentConfig,
      },
    })).toThrow();
  });

  it('accepts codex without baseUrl (defaults to ChatGPT subscription)', () => {
    expect(() => parseConfig({
      agents: {
        standard: { type: 'codex', model: 'gpt-5.5' },
        complex: minimalAgentConfig,
      },
    })).not.toThrow();
  });

  it('throws on invalid effort value', () => {
    expect(() => parseConfig({
      agents: {
        standard: { type: 'claude', model: 'x', effort: 'ultra' } as any,
        complex: minimalAgentConfig,
      },
    })).toThrow();
  });

  it('throws when agents missing', () => {
    expect(() => parseConfig({})).toThrow();
  });

  it('throws when agents.standard missing', () => {
    expect(() => parseConfig({
      agents: {
        complex: minimalAgentConfig,
      } as any,
    })).toThrow();
  });

  it('throws when agents.complex missing', () => {
    expect(() => parseConfig({
      agents: {
        standard: minimalAgentConfig,
      } as any,
    })).toThrow();
  });

  it('defaults research block when omitted from config', () => {
    const result = parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
    });
    expect(result.research.brave.apiKeys).toEqual([]);
    expect(result.research.brave.timeoutMs).toBe(8000);
    expect(result.research.brave.maxResultsPerQuery).toBe(20);
    expect(result.research.brave.perCallBackoffMs).toBe(250);
    expect(result.research.brave.minPerKeyIntervalMs).toBe(1100);
    expect(result.research.builtinAdapters.arxiv).toBe(true);
    expect(result.research.builtinAdapters.semanticScholar).toBe(true);
    expect(result.research.builtinAdapters.githubSearch).toBe(true);
  });

  it('accepts partial research config', () => {
    const result = parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
      },
      research: {
        brave: { apiKeys: ['k1'], timeoutMs: 5000 },
      },
    });
    expect(result.research.brave.apiKeys).toEqual(['k1']);
    expect(result.research.brave.timeoutMs).toBe(5000);
    // untouched defaults
    expect(result.research.brave.maxResultsPerQuery).toBe(20);
    expect(result.research.builtinAdapters.arxiv).toBe(true);
  });

});
