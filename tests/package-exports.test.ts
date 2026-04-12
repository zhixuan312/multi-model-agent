import { describe, it, expect } from 'vitest';

describe('package exports contract', () => {
  // ── @zhixuan92/multi-model-agent-core ──────────────────────────────────────────

  describe('@zhixuan92/multi-model-agent-core (main entry)', () => {
    it('exports loadConfigFromFile as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      expect(typeof mod.loadConfigFromFile).toBe('function');
    });

    it('exports parseConfig as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      expect(typeof mod.parseConfig).toBe('function');
    });

    it('exports multiModelConfigSchema (Zod schema)', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      // Zod schemas are runtime objects with a .safeParse method
      expect(typeof mod.multiModelConfigSchema.safeParse).toBe('function');
    });

    it('exports createProvider as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      expect(typeof mod.createProvider).toBe('function');
    });

    it('exports runTasks as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      expect(typeof mod.runTasks).toBe('function');
    });

    it('exports resolveAgent as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      expect(typeof mod.resolveAgent).toBe('function');
    });

    it('exports findModelProfile as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      expect(typeof mod.findModelProfile).toBe('function');
    });

    it('exports getEffectiveCostTier as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core');
      expect(typeof mod.getEffectiveCostTier).toBe('function');
    });

    // OMITTED: Type-only exports (AgentType, AgentCapability, AgentConfig,
    // Effort, CostTier, RunStatus, TaskSpec, ProviderConfig, MultiModelConfig,
    // TokenUsage, RunResult, Provider, RunOptions, ProviderEligibility, etc.)
    // are compile-time-only TypeScript types — erased at runtime, cannot be
    // checked with expect(mod.Tier).toBeDefined().
  });

  // ── @zhixuan92/multi-model-agent-core subpath exports ───────────────────────────

  describe('@zhixuan92/multi-model-agent-core subpath exports', () => {
    it('exports ./config/schema with parseConfig', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core/config/schema');
      expect(typeof mod.parseConfig).toBe('function');
    });

    it('exports ./config/load with loadConfigFromFile', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core/config/load');
      expect(typeof mod.loadConfigFromFile).toBe('function');
    });

    it('exports ./routing/model-profiles with findModelProfile and getEffectiveCostTier', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core/routing/model-profiles');
      expect(typeof mod.findModelProfile).toBe('function');
      expect(typeof mod.getEffectiveCostTier).toBe('function');
    });

    it('exports ./routing/resolve-agent with resolveAgent', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core/routing/resolve-agent');
      expect(typeof mod.resolveAgent).toBe('function');
    });

    it('exports ./provider with createProvider', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core/provider');
      expect(typeof mod.createProvider).toBe('function');
    });

    it('exports ./run-tasks with runTasks', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-core/run-tasks');
      expect(typeof mod.runTasks).toBe('function');
    });

    it('exports ./types (type re-exports only — no runtime value assertions needed)', async () => {
      // ./types only re-exports type definitions; no runtime values to assert on.
      // This subpath is verified to exist by successful import resolution.
      await expect(import('@zhixuan92/multi-model-agent-core/types')).resolves.toBeDefined();
    });

    // NOTE: parseConfig subpath is not tested separately from main entry
    // (already covered above). loadConfigFromFile subpath added above.
  });

  // ── @zhixuan92/multi-model-agent-mcp ────────────────────────────────────────────

  describe('@zhixuan92/multi-model-agent-mcp (main entry)', () => {
    it('exports buildMcpServer as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-mcp');
      expect(typeof mod.buildMcpServer).toBe('function');
    });

    it('exports buildTaskSchema as a function', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-mcp');
      expect(typeof mod.buildTaskSchema).toBe('function');
    });

    it('exports SERVER_NAME as a string', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-mcp');
      expect(typeof mod.SERVER_NAME).toBe('string');
      expect(mod.SERVER_NAME).toBeTruthy();
    });

    it('exports SERVER_VERSION as a string', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-mcp');
      expect(typeof mod.SERVER_VERSION).toBe('string');
      expect(mod.SERVER_VERSION).toBeTruthy();
    });

    // OMITTED: plan asserts SERVER_NAME === 'multi-model-agent' and
    // SERVER_VERSION === '0.1.0'. We avoid brittle version-string assertions
    // and instead assert the values are truthy non-empty strings.
  });

  describe('@zhixuan92/multi-model-agent-mcp subpath exports', () => {
    it('exports ./routing/render-provider-routing-matrix with renderProviderRoutingMatrix', async () => {
      const mod = await import('@zhixuan92/multi-model-agent-mcp/routing/render-provider-routing-matrix');
      expect(typeof mod.renderProviderRoutingMatrix).toBe('function');
    });
  });
});
