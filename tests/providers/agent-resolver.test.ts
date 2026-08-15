import { describe, it, expect } from 'vitest';
import { resolveAgent } from '../../packages/core/src/providers/agent-resolver.js';
import { createProvider } from '../../packages/core/src/providers/provider-factory.js';
import type { MultiModelConfig } from '@zhixuan92/multi-model-agent-core';

const tier = { type: 'claude' as const, model: 'claude-sonnet-5' };
const runnable = { agents: { standard: tier, complex: tier, main: tier } } as unknown as MultiModelConfig;

/**
 * `agents` is optional in `multiModelConfigSchema` — a half-configured file is a real state on
 * the way to a complete one, so `mma configure-provider` can write one tier at a time. Both
 * `resolveAgent` and `createProvider` therefore have to answer for a config that cannot run.
 *
 * They each answered SEPARATELY, and differently: `resolveAgent` threw `agent_not_configured:
 * config has no agents block`, while the `createProvider` it immediately delegates to threw
 * `No agent tiers are configured. Add agents.standard, agents.complex and agents.main to your
 * config.` One condition, two messages, and which one a caller read depended on which entry
 * point they happened to use. The first message is also the less useful one — it names neither
 * the tiers to add nor how to add them.
 */
describe('agent resolution reports a missing tier once', () => {
  it('gives the SAME message whether resolved through resolveAgent or createProvider', () => {
    const noAgents = {} as MultiModelConfig;
    const viaResolver = (() => { try { resolveAgent('main', noAgents); } catch (e) { return (e as Error).message; } })();
    const viaFactory = (() => { try { createProvider('main', noAgents); } catch (e) { return (e as Error).message; } })();
    expect(viaResolver).toBe(viaFactory);

    const oneTierMissing = { agents: { standard: tier, complex: tier } } as unknown as MultiModelConfig;
    const resolverPartial = (() => { try { resolveAgent('main', oneTierMissing); } catch (e) { return (e as Error).message; } })();
    const factoryPartial = (() => { try { createProvider('main', oneTierMissing); } catch (e) { return (e as Error).message; } })();
    expect(resolverPartial).toBe(factoryPartial);
  });

  it('says what to add, not merely that something is absent', () => {
    const message = (() => { try { resolveAgent('main', {} as MultiModelConfig); } catch (e) { return (e as Error).message; } })();
    expect(message).toContain('agents.standard');
    expect(message).toContain('agents.main');
  });

  it('resolves a runnable config, labelling the provider with its tier', () => {
    expect(resolveAgent('complex', runnable)).toMatchObject({ slot: 'complex', provider: { name: 'complex' } });
  });
});
