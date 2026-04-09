# Model Routing Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Help the consumer LLM route delegated subtasks to the right provider by enriching the `delegate_tasks` tool description with a capability/profile matrix and adding forced `tier` + `requiredCapabilities` schema fields as a commitment device.

**Architecture:** Three new pure-function modules under `src/routing/` produce a rendered matrix string that is injected into the `delegate_tasks` tool description at MCP-connect time. The tool schema gains two required fields per task (`tier`, `requiredCapabilities`) to force the consumer LLM to commit to a judgment before routing. Cost is config-overridable via a new optional `costTier` field so users with flat-rate or self-hosted providers can mark them as `free`.

**Tech Stack:** TypeScript (Node >= 22, ESM-only), Zod for schema validation, Vitest for tests, `@modelcontextprotocol/sdk` for the MCP server. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-09-model-routing-guidance-design.md`

---

## Pre-flight

- [ ] **Read the spec** at `docs/superpowers/specs/2026-04-09-model-routing-guidance-design.md` before starting. Every task below traces back to a section of that spec.

- [ ] **Confirm baseline is green**

Run: `npm run build && npm test`
Expected: both succeed. If they don't, stop and report — the baseline should be clean before starting this work.

---

## Task 1: Add new types to `src/types.ts`

**Files:**
- Modify: `src/types.ts`

This task has no tests of its own — pure type declarations. Correctness is verified by the build step at the end, and by every downstream task that imports these types.

- [ ] **Step 1: Add `Tier`, `CostTier`, and `Capability` type unions**

In `src/types.ts`, just above the existing `ProviderType` declaration (around line 32), add:

```ts
export type Tier = 'trivial' | 'standard' | 'reasoning';

export type CostTier = 'free' | 'low' | 'medium' | 'high';

export type Capability =
  | 'file_read'
  | 'file_write'
  | 'grep'
  | 'glob'
  | 'shell'
  | 'web_search'
  | 'web_fetch';
```

- [ ] **Step 2: Add `costTier` to `ProviderConfig`**

In the existing `ProviderConfig` interface (around line 34), add `costTier` as the last field before the closing brace:

```ts
export interface ProviderConfig {
  type: ProviderType;
  model: string;
  effort?: string;
  maxTurns?: number;
  timeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  sandboxPolicy?: SandboxPolicy;
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[];
  costTier?: CostTier;
}
```

- [ ] **Step 3: Add required `tier` and `requiredCapabilities` fields to `DelegateTask`**

Modify the `DelegateTask` interface (around line 62). Both new fields are **required** (no `?`), because the entire point is to force the consumer LLM to declare them:

```ts
export interface DelegateTask {
  provider: Provider;
  prompt: string;
  tier: Tier;
  requiredCapabilities: Capability[];
  tools?: ToolMode;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  effort?: string;
  sandboxPolicy?: SandboxPolicy;
}
```

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: `tsc` compiles with errors in `src/cli.ts` (because `DelegateTask` now requires `tier` and `requiredCapabilities` but `cli.ts` doesn't supply them yet). This is expected — Task 6 fixes `cli.ts`. The errors should ONLY be in `cli.ts`. If there are errors elsewhere, investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "Add Tier, CostTier, Capability types and extend ProviderConfig/DelegateTask"
```

---

## Task 2: Add `costTier` to config schema

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write a failing test for `costTier` parsing**

Append to `tests/config.test.ts` inside the `describe('loadConfig', ...)` block (before its closing `});`):

```ts
  it('parses costTier when present', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        minimax: {
          type: 'openai-compatible',
          model: 'MiniMax-M2',
          baseUrl: 'https://api.example.com/v1',
          costTier: 'free',
        },
      },
    }));

    const config = loadConfig(configPath);

    expect(config.providers.minimax.costTier).toBe('free');
  });

  it('accepts config without costTier (optional field)', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        gpt: {
          type: 'openai-compatible',
          model: 'gpt-5',
          baseUrl: 'https://api.example.com/v1',
        },
      },
    }));

    const config = loadConfig(configPath);

    expect(config.providers.gpt.costTier).toBeUndefined();
  });

  it('rejects invalid costTier values', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      providers: {
        bad: {
          type: 'openai-compatible',
          model: 'x',
          baseUrl: 'https://api.example.com/v1',
          costTier: 'gigantic',
        },
      },
    }));

    expect(() => loadConfig(configPath)).toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: The three new tests fail. The first two fail because the current schema drops unknown fields or doesn't recognize `costTier`; the third fails because no validation rejects the bad value.

- [ ] **Step 3: Add `costTier` to the Zod schema**

In `src/config.ts`, find the `providerConfigSchema` block (around line 7). Add `costTier` as the last field before the closing `)`:

```ts
const providerConfigSchema = z.object({
  type: z.enum(['codex', 'claude', 'openai-compatible']),
  model: z.string(),
  effort: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  sandboxPolicy: z.enum(['none', 'cwd-only']).optional(),
  hostedTools: z.array(z.enum(['web_search', 'image_generation', 'code_interpreter'])).optional(),
  costTier: z.enum(['free', 'low', 'medium', 'high']).optional(),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: all tests pass, including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Support costTier in provider config schema"
```

---

## Task 3: Create `src/routing/capabilities.ts`

**Files:**
- Create: `src/routing/capabilities.ts`
- Test: `tests/routing/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/routing/capabilities.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getCapabilities } from '../../src/routing/capabilities.js';
import type { ProviderConfig } from '../../src/types.js';

describe('getCapabilities', () => {
  it('returns base capabilities for codex', () => {
    const config: ProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    const caps = getCapabilities(config);
    expect(caps).toEqual(expect.arrayContaining([
      'file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search',
    ]));
    expect(caps).not.toContain('web_fetch');
  });

  it('returns base capabilities for claude including web_fetch', () => {
    const config: ProviderConfig = { type: 'claude', model: 'claude-opus-4-6' };
    const caps = getCapabilities(config);
    expect(caps).toEqual(expect.arrayContaining([
      'file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search', 'web_fetch',
    ]));
  });

  it('returns only file tools for openai-compatible without hostedTools', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
    };
    const caps = getCapabilities(config);
    expect(caps).toEqual(
      expect.arrayContaining(['file_read', 'file_write', 'grep', 'glob'])
    );
    expect(caps).not.toContain('shell');
    expect(caps).not.toContain('web_search');
    expect(caps).not.toContain('web_fetch');
  });

  it('merges web_search from hostedTools for openai-compatible', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      hostedTools: ['web_search'],
    };
    const caps = getCapabilities(config);
    expect(caps).toContain('web_search');
  });

  it('ignores image_generation and code_interpreter hostedTools (not in routing vocabulary)', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      hostedTools: ['image_generation', 'code_interpreter'],
    };
    const caps = getCapabilities(config);
    // These aren't in the Capability union, so they shouldn't appear
    expect(caps).not.toContain('image_generation' as never);
    expect(caps).not.toContain('code_interpreter' as never);
  });

  it('deduplicates when hostedTools duplicates a base capability', () => {
    const config: ProviderConfig = {
      type: 'claude',
      model: 'claude-opus-4-6',
      hostedTools: ['web_search'], // claude already has web_search
    };
    const caps = getCapabilities(config);
    const webSearchCount = caps.filter((c) => c === 'web_search').length;
    expect(webSearchCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/routing/capabilities.test.ts`
Expected: FAIL with "Cannot find module '../../src/routing/capabilities.js'" (or similar).

- [ ] **Step 3: Create `src/routing/capabilities.ts`**

```ts
import type { Capability, ProviderConfig, ProviderType } from '../types.js';

const BASE_CAPABILITIES: Record<ProviderType, Capability[]> = {
  'codex': ['file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search'],
  'claude': ['file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search', 'web_fetch'],
  'openai-compatible': ['file_read', 'file_write', 'grep', 'glob'],
};

/**
 * Returns the set of capabilities a provider supports, combining the base
 * set for its type with any routing-relevant entries from hostedTools.
 *
 * Only `web_search` is mapped from hostedTools; `image_generation` and
 * `code_interpreter` are accepted in config but not part of the routing
 * vocabulary in v1 (no current task type requires declaring them).
 */
export function getCapabilities(config: ProviderConfig): Capability[] {
  const base = BASE_CAPABILITIES[config.type];
  const hosted: Capability[] = (config.hostedTools ?? []).includes('web_search')
    ? ['web_search']
    : [];
  return Array.from(new Set([...base, ...hosted]));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/routing/capabilities.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routing/capabilities.ts tests/routing/capabilities.test.ts
git commit -m "Add capability map for routing decisions"
```

---

## Task 4: Create `src/routing/model-profiles.ts`

**Files:**
- Create: `src/routing/model-profiles.ts`
- Test: `tests/routing/model-profiles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/routing/model-profiles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findProfile, effectiveCost } from '../../src/routing/model-profiles.js';
import type { ProviderConfig } from '../../src/types.js';

describe('findProfile', () => {
  it('matches claude-opus family by prefix', () => {
    const profile = findProfile('claude-opus-4-6');
    expect(profile.tier).toBe('reasoning');
    expect(profile.defaultCost).toBe('high');
  });

  it('matches claude-sonnet family by prefix', () => {
    const profile = findProfile('claude-sonnet-4-5');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
  });

  it('matches gpt-5 family by prefix', () => {
    const profile = findProfile('gpt-5-codex');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
  });

  it('matches MiniMax-M2 exactly', () => {
    const profile = findProfile('MiniMax-M2');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('low');
    expect(profile.avoidFor).toBeDefined();
  });

  it('is case-insensitive', () => {
    const profile = findProfile('CLAUDE-OPUS-4-6');
    expect(profile.tier).toBe('reasoning');
  });

  it('falls back to default profile for unknown models', () => {
    const profile = findProfile('llama-3-70b');
    expect(profile.tier).toBe('standard');
    expect(profile.defaultCost).toBe('medium');
    expect(profile.bestFor).toMatch(/unprofiled/);
  });

  it('prefers the longest matching prefix', () => {
    // Both 'claude-opus' and 'claude-sonnet' exist; 'claude-opus-4-6' must match claude-opus
    const profile = findProfile('claude-opus-4-6');
    expect(profile.tier).toBe('reasoning'); // opus tier, not sonnet
  });
});

describe('effectiveCost', () => {
  it('returns config costTier override when present', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
      costTier: 'free',
    };
    expect(effectiveCost(config)).toBe('free');
  });

  it('falls back to profile defaultCost when override absent', () => {
    const config: ProviderConfig = {
      type: 'claude',
      model: 'claude-opus-4-6',
    };
    expect(effectiveCost(config)).toBe('high');
  });

  it('falls back to default profile cost for unknown model without override', () => {
    const config: ProviderConfig = {
      type: 'openai-compatible',
      model: 'something-new',
      baseUrl: 'https://api.example.com/v1',
    };
    expect(effectiveCost(config)).toBe('medium');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/routing/model-profiles.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create `src/routing/model-profiles.ts`**

```ts
import type { CostTier, ProviderConfig, Tier } from '../types.js';

export interface ModelProfile {
  tier: Tier;
  defaultCost: CostTier;
  bestFor: string;
  avoidFor?: string;
}

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-opus': {
    tier: 'reasoning',
    defaultCost: 'high',
    bestFor: 'complex, uncertain, open-ended tasks requiring judgment',
  },
  'claude-sonnet': {
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'well-scoped code and analysis',
  },
  'gpt-5': {
    tier: 'standard',
    defaultCost: 'medium',
    bestFor: 'code implementation + live data lookup',
  },
  'MiniMax-M2': {
    tier: 'standard',
    defaultCost: 'low',
    bestFor: 'well-defined local code tasks with explicit requirements',
    avoidFor: 'ambiguous or research-style tasks',
  },
};

const DEFAULT_PROFILE: ModelProfile = {
  tier: 'standard',
  defaultCost: 'medium',
  bestFor: 'general tasks (unprofiled model — defaults applied)',
};

/**
 * Find the quality profile for a model by longest-prefix match against the
 * known family map. Case-insensitive. Falls back to DEFAULT_PROFILE for
 * unmatched models — safe baseline rather than a guess.
 */
export function findProfile(modelId: string): ModelProfile {
  const normalized = modelId.toLowerCase();
  const keys = Object.keys(MODEL_PROFILES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(key.toLowerCase())) {
      return MODEL_PROFILES[key];
    }
  }
  return DEFAULT_PROFILE;
}

/**
 * Returns the effective cost tier for a provider: config override if set,
 * otherwise the profile's defaultCost. This is the only profile dimension
 * that is user-configurable, because cost legitimately varies by deployment.
 */
export function effectiveCost(config: ProviderConfig): CostTier {
  return config.costTier ?? findProfile(config.model).defaultCost;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/routing/model-profiles.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routing/model-profiles.ts tests/routing/model-profiles.test.ts
git commit -m "Add family-prefix model profile map with cost override"
```

---

## Task 5: Create `src/routing/describe.ts`

**Files:**
- Create: `src/routing/describe.ts`
- Test: `tests/routing/describe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/routing/describe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { describeProviders } from '../../src/routing/describe.js';
import type { MultiModelConfig } from '../../src/types.js';

const makeConfig = (overrides: Partial<MultiModelConfig['providers']> = {}): MultiModelConfig => ({
  providers: {
    codex: { type: 'codex', model: 'gpt-5-codex' },
    claude: { type: 'claude', model: 'claude-opus-4-6' },
    minimax: {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
      costTier: 'free',
    },
    ...overrides,
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
});

describe('describeProviders', () => {
  it('includes every provider name', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('codex');
    expect(out).toContain('claude');
    expect(out).toContain('minimax');
  });

  it('shows the model id for each provider', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('gpt-5-codex');
    expect(out).toContain('claude-opus-4-6');
    expect(out).toContain('MiniMax-M2');
  });

  it('renders the capability list per provider', () => {
    const out = describeProviders(makeConfig());
    // codex has shell + web_search, minimax has only file tools
    expect(out).toMatch(/codex[\s\S]*shell/);
    expect(out).toMatch(/codex[\s\S]*web_search/);
    expect(out).toMatch(/minimax[\s\S]*file_read/);
  });

  it('shows effective cost tier', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('cost: high'); // claude-opus default
    expect(out).toContain('cost: free'); // minimax override
  });

  it('marks cost as "(from config)" when costTier is overridden', () => {
    const out = describeProviders(makeConfig());
    // minimax has costTier: 'free' in config
    expect(out).toMatch(/minimax[\s\S]*cost: free[\s\S]*\(from config\)/);
  });

  it('does not mark cost as "(from config)" when using profile default', () => {
    const out = describeProviders(makeConfig());
    // claude has no costTier override, so cost: high should NOT have "(from config)"
    const claudeBlock = out.split('claude')[1]?.split('minimax')[0] ?? '';
    expect(claudeBlock).toContain('cost: high');
    expect(claudeBlock).not.toContain('cost: high (from config)');
  });

  it('includes the routing recipe', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('Capability filter');
    expect(out).toContain('Quality filter');
    expect(out).toContain('Cost preference');
    expect(out).toContain('STRONG');
  });

  it('includes tier guidance for the consumer LLM', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('trivial');
    expect(out).toContain('standard');
    expect(out).toContain('reasoning');
  });

  it('stays within a reasonable token budget', () => {
    const out = describeProviders(makeConfig());
    // Rough proxy: ~4 chars/token. Budget: 500 tokens ≈ 2000 chars.
    expect(out.length).toBeLessThan(2000);
  });

  it('renders the tier and bestFor for a known model', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('tier: reasoning'); // claude-opus
    expect(out).toContain('complex, uncertain'); // from claude-opus bestFor
  });

  it('includes avoidFor when present', () => {
    const out = describeProviders(makeConfig());
    expect(out).toContain('avoid for'); // minimax has avoidFor
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/routing/describe.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Create `src/routing/describe.ts`**

```ts
import type { Capability, MultiModelConfig, ProviderConfig } from '../types.js';
import { getCapabilities } from './capabilities.js';
import { effectiveCost, findProfile, type ModelProfile } from './model-profiles.js';

const ROUTING_RECIPE = `How to route a task:
1. Capability filter (HARD): exclude providers missing any required capability.
2. Quality filter: exclude providers whose tier is below the task's tier.
   Tier ordering: trivial < standard < reasoning.
3. Cost preference (STRONG): among the remainder, prefer the cheapest tier.
   If a 'free' provider qualifies, pick it. Only escalate to paid tiers when
   the task tier or required capabilities demand it.

Tier guidance for the consumer LLM:
- 'trivial' — well-defined edits, lookups, formatting. One obvious answer.
- 'standard' — most code work. Clear spec, multiple valid approaches.
- 'reasoning' — ambiguous, architectural, research, or high-stakes.
  Use when requirements are unclear or judgment is required.`;

function renderProviderBlock(
  name: string,
  config: ProviderConfig,
  capabilities: Capability[],
  profile: ModelProfile,
  costSource: 'config' | 'default',
): string {
  const cost = effectiveCost(config);
  const costSuffix = costSource === 'config' ? ' (from config)' : '';
  const lines = [
    `${name} (${config.model})`,
    `  tools: ${capabilities.join(', ')}`,
    `  tier: ${profile.tier} | cost: ${cost}${costSuffix}`,
    `  best for: ${profile.bestFor}`,
  ];
  if (profile.avoidFor) {
    lines.push(`  avoid for: ${profile.avoidFor}`);
  }
  return lines.join('\n');
}

/**
 * Renders the full routing matrix for the delegate_tasks tool description.
 * Loaded once per MCP session when the server starts; the consumer LLM uses
 * it to decide which provider to route each subtask to.
 */
export function describeProviders(config: MultiModelConfig): string {
  const blocks = Object.entries(config.providers).map(([name, providerConfig]) => {
    const capabilities = getCapabilities(providerConfig);
    const profile = findProfile(providerConfig.model);
    const costSource: 'config' | 'default' = providerConfig.costTier ? 'config' : 'default';
    return renderProviderBlock(name, providerConfig, capabilities, profile, costSource);
  });

  return [
    'Delegate tasks to sub-agents running on different LLM providers.',
    'All tasks execute concurrently.',
    '',
    'Available providers:',
    '',
    blocks.join('\n\n'),
    '',
    ROUTING_RECIPE,
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/routing/describe.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/routing/describe.ts tests/routing/describe.test.ts
git commit -m "Add describeProviders renderer for tool description matrix"
```

---

## Task 6: Wire matrix and forced fields into `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Extend `tests/cli.test.ts` with new assertions**

Replace the entire contents of `tests/cli.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from '../src/cli.js';
import type { MultiModelConfig } from '../src/types.js';

const sampleConfig = (): MultiModelConfig => ({
  providers: {
    mock: {
      type: 'openai-compatible',
      model: 'test-model',
      baseUrl: 'http://localhost:1234/v1',
    },
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
});

describe('server metadata', () => {
  it('server name is multi-model-agent', () => {
    expect(SERVER_NAME).toBe('multi-model-agent');
  });

  it('server version matches package version', () => {
    expect(SERVER_VERSION).toBe('0.1.0');
  });
});

describe('buildMcpServer', () => {
  it('creates an MCP server with delegate_tasks tool', () => {
    const server = buildMcpServer(sampleConfig());
    expect(server).toBeDefined();
  });

  it('throws when config has no providers', () => {
    const config: MultiModelConfig = {
      providers: {},
      defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
    };
    expect(() => buildMcpServer(config)).toThrow(/at least one configured provider/);
  });
});

describe('delegate_tasks tool description', () => {
  it('includes the routing matrix from describeProviders', () => {
    const server = buildMcpServer(sampleConfig());
    // Access the registered tool via the server's internal tool map.
    // MCP SDK exposes registered tools; we check via a round-trip through
    // the server's listTools request handler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    const delegate = tools['delegate_tasks'];
    expect(delegate).toBeDefined();
    expect(delegate.description).toContain('Available providers');
    expect(delegate.description).toContain('mock');
    expect(delegate.description).toContain('Capability filter');
    expect(delegate.description).toContain('STRONG');
  });
});

describe('delegate_tasks schema', () => {
  // Build the task schema standalone so we can parse test payloads.
  // This mirrors the shape used inside buildMcpServer — if you change one,
  // change the other.
  const taskSchema = z.object({
    prompt: z.string(),
    provider: z.enum(['mock']),
    tier: z.enum(['trivial', 'standard', 'reasoning']),
    requiredCapabilities: z.array(z.enum([
      'file_read', 'file_write', 'grep', 'glob',
      'shell', 'web_search', 'web_fetch',
    ])),
    tools: z.enum(['none', 'full']).optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    cwd: z.string().optional(),
    effort: z.string().optional(),
    sandboxPolicy: z.enum(['none', 'cwd-only']).optional(),
  });

  it('accepts a task with tier and requiredCapabilities', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: ['file_read'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a task missing tier', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a task missing requiredCapabilities', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid tier values', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'super-duper',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid capability values', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'standard',
      requiredCapabilities: ['psychic_powers'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty requiredCapabilities array', () => {
    const result = taskSchema.safeParse({
      prompt: 'do thing',
      provider: 'mock',
      tier: 'trivial',
      requiredCapabilities: [],
    });
    expect(result.success).toBe(true);
  });
});
```

Note: the `_registeredTools` access is a deliberate internal hook — the MCP SDK's `McpServer` stores registered tools there. If this attribute name changes in a future SDK version, the test will break clearly and can be updated.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts`
Expected: Several tests fail — the matrix isn't in the description yet, and the schema doesn't have `tier` / `requiredCapabilities`. The build may also fail on `src/cli.ts` because of Task 1's type changes.

- [ ] **Step 3: Update `src/cli.ts` to inject the matrix and add forced fields**

Replace the `server.tool('delegate_tasks', ...)` call block (currently around lines 29–77) with:

```ts
  server.tool(
    'delegate_tasks',
    describeProviders(config),
    {
      tasks: z.array(z.object({
        prompt: z.string().describe('Task prompt for the sub-agent'),
        provider: z.enum(availableProviders).describe('Provider name'),
        tier: z.enum(['trivial', 'standard', 'reasoning'])
          .describe('Required quality tier. See the routing recipe in this tool description — match the task to a provider that meets this tier.'),
        requiredCapabilities: z.array(z.enum([
          'file_read', 'file_write', 'grep', 'glob',
          'shell', 'web_search', 'web_fetch',
        ])).describe('Capabilities this task requires. Empty array if none. Consumer LLM MUST exclude providers missing any required capability.'),
        tools: z.enum(['none', 'full']).optional().describe('Tool access mode. Default: full'),
        maxTurns: z.number().int().positive().optional().describe('Max agent loop turns. Default: 200'),
        timeoutMs: z.number().int().positive().optional().describe('Timeout in ms. Default: 600000'),
        cwd: z.string().optional().describe('Working directory for file/shell tools'),
        effort: z.string().optional().describe('Reasoning effort level'),
        sandboxPolicy: z.enum(['none', 'cwd-only']).optional().describe('File-system confinement policy. Default: cwd-only'),
      })).describe('Array of tasks to execute in parallel'),
    },
    async ({ tasks }) => {
      const delegateTasks: DelegateTask[] = tasks.map(t => {
        const provider = createProvider(t.provider, config);
        return {
          provider,
          prompt: t.prompt,
          tier: t.tier,
          requiredCapabilities: t.requiredCapabilities,
          tools: t.tools,
          maxTurns: t.maxTurns,
          timeoutMs: t.timeoutMs,
          cwd: t.cwd,
          effort: t.effort,
          sandboxPolicy: t.sandboxPolicy,
        };
      });

      const results = await delegateAll(delegateTasks);

      const response = {
        results: results.map((r, i) => ({
          provider: tasks[i].provider,
          status: r.status,
          output: r.output,
          turns: r.turns,
          files: r.files,
          usage: r.usage,
          ...(r.error && { error: r.error }),
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      };
    },
  );
```

And add the import at the top of `src/cli.ts` (alongside the existing imports):

```ts
import { describeProviders } from './routing/describe.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Run the full test suite and build**

Run: `npm run build && npm test`
Expected: both succeed. If the build fails anywhere outside `src/cli.ts`, investigate — it suggests a downstream consumer of `DelegateTask` that I missed.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "Inject routing matrix into tool description and add forced schema fields"
```

---

## Task 7: End-to-end smoke check

**Files:**
- None modified. This task validates the work holistically.

- [ ] **Step 1: Build and run the full test suite**

Run: `npm run build && npm test`
Expected: all tests pass, build succeeds with no errors.

- [ ] **Step 2: Inspect the rendered tool description**

Run a one-off script to see what the consumer LLM will actually see. From the project root:

```bash
node --input-type=module -e "
import { describeProviders } from './dist/routing/describe.js';
const config = {
  providers: {
    codex: { type: 'codex', model: 'gpt-5-codex' },
    claude: { type: 'claude', model: 'claude-opus-4-6' },
    minimax: { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1', costTier: 'free' },
  },
  defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' },
};
console.log(describeProviders(config));
console.log('---');
console.log('Length:', describeProviders(config).length, 'chars');
"
```

Expected: A clean rendered matrix with three providers, capabilities listed, tier + cost per provider, `(from config)` next to minimax's cost, and the routing recipe at the bottom. Character count under 2000.

- [ ] **Step 3: Verify no regressions in other tests**

Run: `npm test -- --reporter=verbose`
Expected: all existing tests (delegate, config, provider, tools/*, auth/*) still pass. No snapshot mismatches.

- [ ] **Step 4: No commit needed** — this task only validates.

---

## Post-implementation checklist

- [ ] All 7 tasks complete
- [ ] `npm run build` succeeds with no errors
- [ ] `npm test` passes all tests
- [ ] Rendered description looks clean and under the token budget
- [ ] Git log shows one commit per task (6 commits total)
- [ ] No unrelated files modified — the only changed files should be:
  - `src/types.ts`
  - `src/config.ts`
  - `src/cli.ts`
  - `src/routing/capabilities.ts` (new)
  - `src/routing/model-profiles.ts` (new)
  - `src/routing/describe.ts` (new)
  - `tests/config.test.ts`
  - `tests/cli.test.ts`
  - `tests/routing/capabilities.test.ts` (new)
  - `tests/routing/model-profiles.test.ts` (new)
  - `tests/routing/describe.test.ts` (new)

## Notes for the implementing engineer

- **ESM imports require `.js` extensions** even though the source files are `.ts`. The project is ESM-only. If you write `import { foo } from './bar'`, the build will fail — it must be `import { foo } from './bar.js'`.
- **No backward compatibility shims.** This is a v0.1.x project in active development. The two new required schema fields will break any existing `delegate_tasks` caller. That's acceptable per `.claude/rules/development-mode.md`.
- **Do not add features beyond the spec.** No soft warnings, no server-side capability validation, no profile overrides beyond `costTier`. All are listed as out-of-scope in the spec. If you think one is obviously needed, stop and raise it — don't just add it.
- **Commit per task, not at the end.** The plan is structured for frequent commits so a reviewer (or a rollback) can work in small steps.
- **Run the tests after each implementation step**, not just at the end of the task. The TDD cycle is: write failing test → see it fail → implement → see it pass → commit. Don't skip the "see it fail" step — it's cheap insurance that the test actually exercises the new behavior.
