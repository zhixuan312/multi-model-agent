import { describe, it, expect } from 'vitest';
import { parseConfig, assertRunnable } from '@zhixuan92/multi-model-agent-core/config/schema';

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
        main: minimalAgentConfig,
      },
    });
    expect(result.agents.standard.model).toBe('test-model');
  });

  it('parses valid full config', () => {
    const input = {
      agents: {
        standard: { type: 'claude', model: 'claude-sonnet-4-6' },
        complex: { type: 'codex', model: 'gpt-5', baseUrl: 'https://api.example.com' },
        main: { type: 'claude', model: 'claude-opus-4-7' },
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
        main: minimalAgentConfig,
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
        main: minimalAgentConfig,
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
        main: minimalAgentConfig,
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
        main: minimalAgentConfig,
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

  // Tiers are a DAEMON requirement, not a file-shape requirement. A machine can
  // legitimately record `clients.<id>: "on"` before it has chosen any models —
  // that is the whole first-run path — and making the schema reject it meant the
  // only file the roster may live in was a file that could not yet be written.
  it('accepts a config with no agents, so a roster can be recorded before models are chosen', () => {
    expect(() => parseConfig({})).not.toThrow();
    expect(parseConfig({}).agents).toBeUndefined();
  });

  it('assertRunnable is what refuses a config the daemon cannot serve, naming the tiers', () => {
    expect(() => assertRunnable(parseConfig({}))).toThrow(/agents\.standard and agents\.complex/);
    // And it points at the file when it knows which one.
    expect(() => assertRunnable(parseConfig({}), '/tmp/mma.json')).toThrow(/\/tmp\/mma\.json/);
    // Provisioning explicitly does not need tiers — say so where it is read.
    expect(() => assertRunnable(parseConfig({}))).toThrow(/do not need tiers/);
  });

  it('assertRunnable passes a fully configured config through', () => {
    const config = parseConfig({ agents: { standard: minimalAgentConfig, complex: minimalAgentConfig, main: minimalAgentConfig } });
    expect(() => assertRunnable(config)).not.toThrow();
  });

  // A PARTIALLY filled agents block is a real state on the way to a complete
  // one: `mma configure-provider` writes one tier at a time. So the schema
  // accepts it and `assertRunnable` is what refuses to serve it — otherwise the
  // user reads a raw Zod `invalid_type` at path ["agents","main"] instead of a
  // sentence naming the tier to add.
  it('accepts a partially configured agents block, and assertRunnable names each missing tier', () => {
    const noStandard = parseConfig({ agents: { complex: minimalAgentConfig, main: minimalAgentConfig } as any });
    expect(() => assertRunnable(noStandard)).toThrow(/agents\.standard is not configured/);

    const noComplex = parseConfig({ agents: { standard: minimalAgentConfig, main: minimalAgentConfig } as any });
    expect(() => assertRunnable(noComplex)).toThrow(/agents\.complex is not configured/);

    // Every config written before 6.6.0 has exactly this shape.
    const noMain = parseConfig({ agents: { standard: minimalAgentConfig, complex: minimalAgentConfig } as any });
    expect(() => assertRunnable(noMain)).toThrow(/agents\.main is not configured/);
    expect(() => assertRunnable(noMain, '/tmp/mma.json')).toThrow(/\/tmp\/mma\.json/);

    const noWorkers = parseConfig({ agents: { main: minimalAgentConfig } as any });
    expect(() => assertRunnable(noWorkers)).toThrow(/agents\.standard and agents\.complex are not configured/);
  });

  it('defaults research block when omitted from config', () => {
    const result = parseConfig({
      agents: {
        standard: minimalAgentConfig,
        complex: minimalAgentConfig,
        main: minimalAgentConfig,
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
        main: minimalAgentConfig,
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
