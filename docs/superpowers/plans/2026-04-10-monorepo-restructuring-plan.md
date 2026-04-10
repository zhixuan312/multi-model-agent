# Monorepo Restructuring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the repo into a workspace monorepo with `@scope/multi-model-agent-core` (execution engine) and `@scope/multi-model-agent-mcp` (MCP transport adapter). Root becomes workspace-only.

**Architecture:** Build the new API directly in `packages/core/src/` using the approved public contracts (not copy-and-rename from old root). Move first, then refactor. No re-export bridge.

**Tech Stack:** TypeScript, Node >=22, npm workspaces, Vitest, Zod

---

## Phase 1: Scaffold

### Task 1: Create directory structure

**Files:**
- Create: `packages/core/src/{config,routing,runners,tools,auth}`
- Create: `packages/mcp/src/routing/`

- [ ] **Step 1: Create directories**

```bash
mkdir -p packages/core/src/{config,routing,runners,tools,auth}
mkdir -p packages/mcp/src/routing
```

- [ ] **Step 2: Commit**

```bash
git add packages/
git commit -m "chore: create packages directory structure"
```

---

### Task 2: Create tsconfig.base.json

**Files:**
- Create: `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 1: Write tsconfig.base.json**

- [ ] **Step 2: Commit**

```bash
git add tsconfig.base.json
git commit -m "chore: add tsconfig.base.json shared config"
```

---

### Task 3: Create root package.json with toolchain

**Files:**
- Modify: `package.json`

```json
{
  "name": "multi-model-agent",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "devDependencies": {
    "@openai/agents": "^0.8.0",
    "openai": "^6.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 1: Replace package.json content with workspace manifest + toolchain**

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: convert root to workspace manifest with devDependencies"
```

---

### Task 4: Create packages/core/package.json

**Files:**
- Create: `packages/core/package.json`

```json
{
  "name": "@scope/multi-model-agent-core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./config/schema": {
      "types": "./dist/config/schema.d.ts",
      "import": "./dist/config/schema.js"
    },
    "./config/load": {
      "types": "./dist/config/load.d.ts",
      "import": "./dist/config/load.js"
    },
    "./routing/capabilities": {
      "types": "./dist/routing/capabilities.d.ts",
      "import": "./dist/routing/capabilities.js"
    },
    "./routing/model-profiles": {
      "types": "./dist/routing/model-profiles.d.ts",
      "import": "./dist/routing/model-profiles.js"
    },
    "./routing/resolve-task-capabilities": {
      "types": "./dist/routing/resolve-task-capabilities.d.ts",
      "import": "./dist/routing/resolve-task-capabilities.js"
    },
    "./routing/select-provider-for-task": {
      "types": "./dist/routing/select-provider-for-task.d.ts",
      "import": "./dist/routing/select-provider-for-task.js"
    },
    "./routing/get-provider-eligibility": {
      "types": "./dist/routing/get-provider-eligibility.d.ts",
      "import": "./dist/routing/get-provider-eligibility.js"
    },
    "./provider": {
      "types": "./dist/provider.d.ts",
      "import": "./dist/provider.js"
    },
    "./run-tasks": {
      "types": "./dist/run-tasks.d.ts",
      "import": "./dist/run-tasks.js"
    },
    "./types": {
      "types": "./dist/types.d.ts",
      "import": "./dist/types.js"
    }
  },
  "scripts": {
    "build": "tsc"
  },
  "engines": { "node": ">=22.0.0" }
}
```

- [ ] **Step 1: Write packages/core/package.json**

- [ ] **Step 2: Commit**

```bash
git add packages/core/package.json
git commit -m "chore: add @scope/multi-model-agent-core package.json"
```

---

### Task 5: Create packages/core/tsconfig.json

**Files:**
- Create: `packages/core/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 1: Write packages/core/tsconfig.json**

- [ ] **Step 2: Commit**

```bash
git add packages/core/tsconfig.json
git commit -m "chore: add @scope/multi-model-agent-core tsconfig.json"
```

---

### Task 6: Create packages/mcp/package.json

**Files:**
- Create: `packages/mcp/package.json`

```json
{
  "name": "@scope/multi-model-agent-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "multi-model-agent": "./dist/cli.js"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./routing/render-provider-routing-matrix": {
      "types": "./dist/routing/render-provider-routing-matrix.d.ts",
      "import": "./dist/routing/render-provider-routing-matrix.js"
    }
  },
  "scripts": {
    "build": "tsc"
  },
  "engines": { "node": ">=22.0.0" },
  "dependencies": {
    "@scope/multi-model-agent-core": "*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^4.0.0"
  },
  "peerDependencies": {
    "@openai/agents": "^0.8.0",
    "openai": "^6.0.0"
  }
}
```

- [ ] **Step 1: Write packages/mcp/package.json**

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/package.json
git commit -m "chore: add @scope/multi-model-agent-mcp package.json"
```

---

### Task 7: Create packages/mcp/tsconfig.json

**Files:**
- Create: `packages/mcp/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 1: Write packages/mcp/tsconfig.json**

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/tsconfig.json
git commit -m "chore: add @scope/multi-model-agent-mcp tsconfig.json"
```

---

## Phase 2: Core — types.ts (new API)

### Task 8: Create packages/core/src/types.ts

**Files:**
- Create: `packages/core/src/types.ts`

New API types per approved design. Key changes from old:
- `DelegateTask` → `TaskSpec`
- `ProviderConfig` flat → discriminated union (`CodexProviderConfig | ClaudeProviderConfig | OpenAICompatibleProviderConfig`)
- `OpenAICompatibleProviderConfig.baseUrl` is **required**
- `ProviderEligibilityReport` → `ProviderEligibility`
- New fields: `Tier`, `CostTier`, `Effort`, `EligibilityFailure`, `EligibilityFailureCheck`

```typescript
// === Tier & Capability ===

export type Tier = 'trivial' | 'standard' | 'reasoning';
export type Capability = 'file_read' | 'file_write' | 'grep' | 'glob' | 'shell' | 'web_search' | 'web_fetch';
export type ToolMode = 'none' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type RunStatus = 'ok' | 'error' | 'timeout' | 'max_turns';

// === Task ===

export interface TaskSpec {
  prompt: string
  /** Provider name. If omitted, core auto-selects. */
  provider?: string
  tier: Tier
  requiredCapabilities: Capability[]
  tools?: ToolMode
  maxTurns?: number
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
}

// === Provider Config (discriminated union) ===

export interface CodexProviderConfig {
  type: 'codex'
  model: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
}

export interface ClaudeProviderConfig {
  type: 'claude'
  model: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
}

export interface OpenAICompatibleProviderConfig {
  type: 'openai-compatible'
  model: string
  /** Required — must be specified. No default. */
  baseUrl: string
  apiKey?: string
  apiKeyEnv?: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
}

/** Discriminated union — each provider type has distinct required fields. */
export type ProviderConfig =
  | CodexProviderConfig
  | ClaudeProviderConfig
  | OpenAICompatibleProviderConfig

// === Config ===

export interface MultiModelConfig {
  providers: Record<string, ProviderConfig>
  defaults: {
    maxTurns: number
    timeoutMs: number
    tools: ToolMode
  }
}

// === Result ===

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUSD: number | null
}

export interface RunResult {
  output: string
  status: RunStatus
  usage: TokenUsage
  turns: number
  files: string[]
  error?: string
}

// === Provider (created by createProvider) ===

export interface Provider {
  name: string
  config: ProviderConfig
  run(prompt: string, options?: RunOptions): Promise<RunResult>
}

export interface RunOptions {
  tools?: ToolMode
  maxTurns?: number
  timeoutMs?: number
  cwd?: string
  effort?: Effort
  sandboxPolicy?: SandboxPolicy
}

// === Routing / Eligibility ===

export type EligibilityFailureCheck =
  | 'capability'
  | 'tier'
  | 'tool_mode'
  | 'provider_not_found'
  | 'unsupported_provider_type'
  | 'missing_required_field'
  | string

export interface EligibilityFailure {
  check: EligibilityFailureCheck
  detail: string
  message: string
}

export interface ProviderEligibility {
  name: string
  config: ProviderConfig
  eligible: boolean
  /** Reasons only present when eligible === false. */
  reasons: EligibilityFailure[]
}
```

- [ ] **Step 1: Write packages/core/src/types.ts with discriminated ProviderConfig union**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat(core): add new types.ts with TaskSpec, discriminated ProviderConfig"
```

---

## Phase 3: Core — config

### Task 9: Create packages/core/src/config/schema.ts

**Files:**
- Create: `packages/core/src/config/schema.ts`

Zod schemas for the discriminated union. Each provider type has its own schema.

```typescript
import { z } from 'zod';

// === Per-provider Zod schemas ===

const effortSchema = z.enum(['none', 'low', 'medium', 'high']);
const costTierSchema = z.enum(['free', 'low', 'medium', 'high']);
const hostedToolsSchema = z.array(z.enum(['web_search', 'image_generation', 'code_interpreter']));
const sandboxPolicySchema = z.enum(['none', 'cwd-only']).optional();

export const codexProviderConfigSchema: z.ZodType<CodexProviderConfig> = z.object({
  type: z.literal('codex'),
  model: z.string(),
  effort: effortSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  hostedTools: hostedToolsSchema.optional(),
  costTier: costTierSchema.optional(),
});

export const claudeProviderConfigSchema: z.ZodType<ClaudeProviderConfig> = z.object({
  type: z.literal('claude'),
  model: z.string(),
  effort: effortSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  hostedTools: hostedToolsSchema.optional(),
  costTier: costTierSchema.optional(),
});

export const openAICompatibleProviderConfigSchema: z.ZodType<OpenAICompatibleProviderConfig> = z.object({
  type: z.literal('openai-compatible'),
  model: z.string(),
  baseUrl: z.string().min(1, 'baseUrl is required for openai-compatible providers'),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  effort: effortSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  sandboxPolicy: sandboxPolicySchema,
  hostedTools: hostedToolsSchema.optional(),
  costTier: costTierSchema.optional(),
});

export const providerConfigSchema: z.ZodType<ProviderConfig> = z.discriminatedUnion('type', [
  codexProviderConfigSchema,
  claudeProviderConfigSchema,
  openAICompatibleProviderConfigSchema,
]);

// === MultiModelConfig schema ===

const defaultsSchema = z.object({
  maxTurns: z.number().int().positive().default(200),
  timeoutMs: z.number().int().positive().default(600_000),
  tools: z.enum(['none', 'full']).default('full'),
}).default(() => ({ maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const }));

export const multiModelConfigSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema).default({}),
  defaults: defaultsSchema,
});

export interface ParsedConfigSuccess {
  config: MultiModelConfig
  success: true
}

export interface ParsedConfigFailure {
  success: false
  error: string
}

export type ParseConfigResult = ParsedConfigSuccess | ParsedConfigFailure

/**
 * Parse a raw config object — validates schema, no side effects.
 * Does NOT load from disk.
 */
export function parseConfig(raw: unknown): MultiModelConfig {
  return multiModelConfigSchema.parse(raw);
}
```

Note: `parseConfig` replaces the old `loadConfig`. Only `loadConfigFromFile` (Task 10) handles file I/O.

- [ ] **Step 1: Write packages/core/src/config/schema.ts with discriminated Zod schemas**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/config/schema.ts
git commit -m "feat(core): add config/schema.ts with discriminated Zod union"
```

---

### Task 10: Create packages/core/src/config/load.ts

**Files:**
- Create: `packages/core/src/config/load.ts`

**Critical:** Only `loadConfigFromFile(path)` — no auto-discovery, no MULTI_MODEL_CONFIG reading, no search paths. Discovery belongs to MCP CLI.

```typescript
import fs from 'fs';
import { multiModelConfigSchema } from './schema.js';
import type { MultiModelConfig } from '../types.js';

/**
 * Load and parse a config file by path.
 * No auto-lookup — callers must provide the path.
 * Core has no knowledge of MULTI_MODEL_CONFIG env var or home-directory discovery.
 */
export async function loadConfigFromFile(path: string): Promise<MultiModelConfig> {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf-8', (err, data) => {
      if (err) {
        reject(new Error(`Config file not found: ${path}`));
        return;
      }
      try {
        const raw = JSON.parse(data);
        resolve(multiModelConfigSchema.parse(raw));
      } catch (e) {
        reject(new Error(`Invalid config at ${path}: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}
```

- [ ] **Step 1: Write packages/core/src/config/load.ts — loadConfigFromFile only, no auto-discovery**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/config/load.ts
git commit -m "feat(core): add config/load.ts with loadConfigFromFile (no auto-discovery)"
```

---

## Phase 4: Core — routing

### Task 11: Create packages/core/src/routing/model-profiles.ts

**Files:**
- Create: `packages/core/src/routing/model-profiles.ts`

Copied from old `src/routing/model-profiles.ts` with renamed exports: `findProfile` → `findModelProfile`, `effectiveCost` → `getEffectiveCostTier`.

- [ ] **Step 1: Read old src/routing/model-profiles.ts, copy to packages/core/src/routing/model-profiles.ts**
- [ ] **Step 2: Rename `findProfile` → `findModelProfile`, `effectiveCost` → `getEffectiveCostTier`**
- [ ] **Step 3: Commit**

```bash
git add packages/core/src/routing/model-profiles.ts
git commit -m "feat(core): add routing/model-profiles.ts with findModelProfile, getEffectiveCostTier"
```

---

### Task 12: Create packages/core/src/routing/capabilities.ts

**Files:**
- Create: `packages/core/src/routing/capabilities.ts`

Copied from old `src/routing/capabilities.ts`. Rename: `getCapabilities` → `getBaseCapabilities`.

- [ ] **Step 1: Read old src/routing/capabilities.ts, copy to packages/core/src/routing/capabilities.ts**
- [ ] **Step 2: Rename `getCapabilities` → `getBaseCapabilities`**
- [ ] **Step 3: Commit**

```bash
git add packages/core/src/routing/capabilities.ts
git commit -m "feat(core): add routing/capabilities.ts with getBaseCapabilities"
```

---

### Task 13: Create packages/core/src/routing/resolve-task-capabilities.ts

**Files:**
- Create: `packages/core/src/routing/resolve-task-capabilities.ts`

New file. The `resolveTaskCapabilities` function computes actual runtime capabilities accounting for tools mode and sandboxPolicy overrides.

```typescript
import type { Capability, ProviderConfig, RunOptions } from '../types.js';
import { getBaseCapabilities } from './capabilities.js';

/**
 * Returns the capabilities a task will have at runtime, accounting for
 * tools, sandboxPolicy, and hosted tools overrides.
 */
export function resolveTaskCapabilities(
  providerConfig: ProviderConfig,
  options: Pick<RunOptions, 'tools' | 'sandboxPolicy'>,
): Capability[] {
  // If tools are disabled for this task, no capabilities are offered.
  if (options.tools === 'none') return [];

  // Merge the per-task sandboxPolicy override (if any) into a config snapshot
  // before asking getBaseCapabilities. The provider's persisted config is NOT
  // mutated.
  const mergedConfig: ProviderConfig = {
    ...providerConfig,
    sandboxPolicy: options.sandboxPolicy ?? providerConfig.sandboxPolicy,
  };

  return getBaseCapabilities(mergedConfig);
}
```

- [ ] **Step 1: Write packages/core/src/routing/resolve-task-capabilities.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/routing/resolve-task-capabilities.ts
git commit -m "feat(core): add routing/resolve-task-capabilities.ts with resolveTaskCapabilities"
```

---

### Task 14: Create packages/core/src/routing/select-provider-for-task.ts

**Files:**
- Create: `packages/core/src/routing/select-provider-for-task.ts`

New file. Implements the auto-routing algorithm per approved design.

```typescript
import type { ProviderConfig, TaskSpec, MultiModelConfig } from '../types.js';
import { resolveTaskCapabilities } from './resolve-task-capabilities.js';
import { findModelProfile, getEffectiveCostTier } from './model-profiles.js';

export interface SelectedProvider {
  name: string
  config: ProviderConfig
}

/**
 * Select which provider to use for a task (when provider is omitted).
 * Algorithm:
 * 1. Capability filter (HARD): exclude providers missing any requiredCapability.
 * 2. Tier filter (HARD): exclude providers whose findModelProfile(model).tier < task.tier.
 *    Tier ordering: trivial < standard < reasoning.
 * 3. Cost preference (STRONG): among remainder, select cheapest costTier.
 * 4. Tiebreaker: ASCII/lexicographic by provider name.
 *
 * Returns null if no provider passes all filters.
 */
export function selectProviderForTask(
  task: TaskSpec,
  config: MultiModelConfig,
): SelectedProvider | null {
  const TIER_ORDER: Record<string, number> = { trivial: 0, standard: 1, reasoning: 2 };

  const eligible: { name: string; config: ProviderConfig; costTier: string }[] = [];

  for (const [name, providerConfig] of Object.entries(config.providers)) {
    // 1. Capability check
    const caps = resolveTaskCapabilities(providerConfig, {
      tools: task.tools ?? 'full',
      sandboxPolicy: task.sandboxPolicy ?? providerConfig.sandboxPolicy,
    });
    const missing = task.requiredCapabilities.filter((c) => !caps.includes(c));
    if (missing.length > 0) continue;

    // 2. Tier check
    const profile = findModelProfile(providerConfig.model);
    const requiredTierOrder = TIER_ORDER[task.tier] ?? 0;
    const providerTierOrder = TIER_ORDER[profile.tier] ?? 0;
    if (providerTierOrder < requiredTierOrder) continue;

    // Passed both filters — track for cost comparison
    const costTier = getEffectiveCostTier(providerConfig);
    eligible.push({ name, config: providerConfig, costTier });
  }

  if (eligible.length === 0) return null;

  // 3. Sort by cost tier: free < low < medium < high
  const COST_ORDER: Record<string, number> = { free: 0, low: 1, medium: 2, high: 3 };
  eligible.sort((a, b) => {
    const costDiff = (COST_ORDER[a.costTier] ?? 3) - (COST_ORDER[b.costTier] ?? 3);
    if (costDiff !== 0) return costDiff;
    // 4. Tiebreaker: provider name ascending
    return a.name.localeCompare(b.name);
  });

  const winner = eligible[0];
  return { name: winner.name, config: winner.config };
}
```

- [ ] **Step 1: Write packages/core/src/routing/select-provider-for-task.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/routing/select-provider-for-task.ts
git commit -m "feat(core): add routing/select-provider-for-task.ts with selectProviderForTask"
```

---

### Task 15: Create packages/core/src/routing/get-provider-eligibility.ts

**Files:**
- Create: `packages/core/src/routing/get-provider-eligibility.ts`

New file. Returns structured eligibility report per approved design.

```typescript
import type {
  EligibilityFailure,
  MultiModelConfig,
  ProviderConfig,
  ProviderEligibility,
  TaskSpec,
  Tier,
} from '../types.js';
import { resolveTaskCapabilities } from './resolve-task-capabilities.js';
import { findModelProfile, getEffectiveCostTier } from './model-profiles.js';

const TIER_ORDER: Record<Tier, number> = { trivial: 0, standard: 1, reasoning: 2 };

/**
 * Returns structured eligibility report for every configured provider.
 * Each entry states whether the provider is eligible and, if not, which
 * specific checks failed and why.
 */
export function getProviderEligibility(
  task: TaskSpec,
  config: MultiModelConfig,
): ProviderEligibility[] {
  return Object.entries(config.providers).map(([name, providerConfig]): ProviderEligibility => {
    const reasons: EligibilityFailure[] = [];

    // Capability check
    const caps = resolveTaskCapabilities(providerConfig, {
      tools: task.tools ?? 'full',
      sandboxPolicy: task.sandboxPolicy ?? providerConfig.sandboxPolicy,
    });
    const missing = task.requiredCapabilities.filter((c) => !caps.includes(c));
    if (missing.length > 0) {
      reasons.push({
        check: 'capability',
        detail: `missing: ${missing.join(', ')}`,
        message: `Provider "${name}" cannot satisfy requiredCapabilities: ${missing.join(', ')}.`,
      });
    }

    // Tier check
    const profile = findModelProfile(providerConfig.model);
    const requiredTierOrder = TIER_ORDER[task.tier];
    const providerTierOrder = TIER_ORDER[profile.tier];
    if (providerTierOrder < requiredTierOrder) {
      reasons.push({
        check: 'tier',
        detail: `provider tier: ${profile.tier}, required: ${task.tier}`,
        message: `Provider "${name}" (${profile.tier}) is below required tier ${task.tier}.`,
      });
    }

    // OpenAI-compatible requires baseUrl (but this is caught by schema at parse time,
    // so we surface it here as a sanity check)
    if (providerConfig.type === 'openai-compatible' && !providerConfig.baseUrl) {
      reasons.push({
        check: 'missing_required_field',
        detail: 'baseUrl is missing',
        message: `Provider "${name}" (openai-compatible) is missing required field: baseUrl.`,
      });
    }

    return {
      name,
      config: providerConfig,
      eligible: reasons.length === 0,
      reasons,
    };
  });
}
```

- [ ] **Step 1: Write packages/core/src/routing/get-provider-eligibility.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/routing/get-provider-eligibility.ts
git commit -m "feat(core): add routing/get-provider-eligibility.ts with getProviderEligibility"
```

---

## Phase 5: Core — runners, tools, auth

### Task 16: Copy runners, tools, auth to core

**Files:**
- Copy: `src/runners/*` → `packages/core/src/runners/`
- Copy: `src/tools/*` → `packages/core/src/tools/`
- Copy: `src/auth/*` → `packages/core/src/auth/`

Internal to core. Update relative imports to stay within `packages/core/src/`.

- [ ] **Step 1: Copy runner, tool, and auth files**

```bash
cp src/runners/*.ts packages/core/src/runners/
cp src/tools/*.ts packages/core/src/tools/
cp src/auth/*.ts packages/core/src/auth/
```

- [ ] **Step 2: Review each copied file — update imports that reference `../types.js` to `./types.js` etc.**

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/runners/ packages/core/src/tools/ packages/core/src/auth/
git commit -m "chore(core): copy runners, tools, auth (internal, not exported)"
```

---

## Phase 6: Core — provider, run-tasks, index

### Task 17: Create packages/core/src/provider.ts

**Files:**
- Copy: `src/provider.ts` → `packages/core/src/provider.ts`

Update imports to use relative paths within core.

- [ ] **Step 1: Copy src/provider.ts to packages/core/src/provider.ts**

- [ ] **Step 2: Update imports (e.g. `from './types.js'` stays the same since it's in the same package)**

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/provider.ts
git commit -m "chore(core): copy provider.ts to core"
```

---

### Task 18: Create packages/core/src/run-tasks.ts

**Files:**
- Create: `packages/core/src/run-tasks.ts`

New implementation. Replaces `delegate.ts`. Implements `runTasks()` per approved design:
- `runTasks(tasks, config)` — orchestrator
- `executeTask(task, provider, config)` — single-task executor
- Uses `selectProviderForTask` for auto-routing
- Uses `getProviderEligibility` for pre-execution validation

```typescript
import type { Provider, RunResult, RunOptions, TaskSpec, MultiModelConfig } from './types.js';
import { createProvider } from './provider.js';
import { getProviderEligibility } from './routing/get-provider-eligibility.js';
import { selectProviderForTask } from './routing/select-provider-for-task.js';
import { resolveTaskCapabilities } from './routing/resolve-task-capabilities.js';

function errorResult(error: string): RunResult {
  return {
    output: `Sub-agent error: ${error}`,
    status: 'error',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
    turns: 0,
    files: [],
    error,
  };
}

async function executeTask(
  task: TaskSpec,
  provider: Provider,
  config: MultiModelConfig,
): Promise<RunResult> {
  try {
    return await provider.run(task.prompt, {
      tools: task.tools,
      maxTurns: task.maxTurns,
      timeoutMs: task.timeoutMs,
      cwd: task.cwd,
      effort: task.effort,
      sandboxPolicy: task.sandboxPolicy,
    });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Run tasks concurrently. Each RunResult corresponds to the matching TaskSpec
 * at the same index. One task failing does not affect others.
 */
export async function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  const resolved = tasks.map((task): { task: TaskSpec; provider: Provider } => {
    // If provider specified, validate and use it
    if (task.provider) {
      const eligibility = getProviderEligibility(task, config);
      const report = eligibility.find((e) => e.name === task.provider);
      if (!report) {
        // Provider not found in config
        const notFoundProvider = createProvider(task.provider, {
          providers: {},
          defaults: config.defaults,
        });
        return { task, provider: notFoundProvider };
      }
      if (!report.eligible) {
        const reasons = report.reasons.map((r) => r.message).join('; ');
        return {
          task,
          provider: createProvider(report.name, config),
        };
      }
      return {
        task,
        provider: createProvider(task.provider, config),
      };
    }

    // Auto-routing
    const selected = selectProviderForTask(task, config);
    if (!selected) {
      return {
        task,
        provider: createProvider(Object.keys(config.providers)[0], config),
      };
    }
    return {
      task,
      provider: createProvider(selected.name, config),
    };
  });

  return Promise.all(
    resolved.map(({ task, provider }) => executeTask(task, provider, config)),
  );
}
```

- [ ] **Step 1: Write packages/core/src/run-tasks.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/run-tasks.ts
git commit -m "feat(core): add run-tasks.ts with runTasks() orchestrator"
```

---

### Task 19: Create packages/core/src/index.ts

**Files:**
- Create: `packages/core/src/index.ts`

Re-exports the full public API.

```typescript
// Config
export { loadConfigFromFile } from './config/load.js';
export { parseConfig, multiModelConfigSchema } from './config/schema.js';

// Types (re-export all)
export type {
  Tier,
  Capability,
  ToolMode,
  SandboxPolicy,
  Effort,
  CostTier,
  RunStatus,
  TaskSpec,
  ProviderConfig,
  CodexProviderConfig,
  ClaudeProviderConfig,
  OpenAICompatibleProviderConfig,
  MultiModelConfig,
  TokenUsage,
  RunResult,
  Provider,
  RunOptions,
  EligibilityFailureCheck,
  EligibilityFailure,
  ProviderEligibility,
} from './types.js';

// Provider
export { createProvider } from './provider.js';

// Run tasks
export { runTasks } from './run-tasks.js';

// Routing helpers
export { getBaseCapabilities } from './routing/capabilities.js';
export { resolveTaskCapabilities } from './routing/resolve-task-capabilities.js';
export { findModelProfile, getEffectiveCostTier } from './routing/model-profiles.js';
export { selectProviderForTask } from './routing/select-provider-for-task.js';
export { getProviderEligibility } from './routing/get-provider-eligibility.js';
```

- [ ] **Step 1: Write packages/core/src/index.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add public API index.ts"
```

---

## Phase 7: MCP package

### Task 20: Create packages/mcp/src/routing/render-provider-routing-matrix.ts

**Files:**
- Create: `packages/mcp/src/routing/render-provider-routing-matrix.ts`

Moved from `src/routing/describe.ts`. Updated imports to use `@scope/multi-model-agent-core`.

Function renamed: `describeProviders` → `renderProviderRoutingMatrix`.

```typescript
import type { Capability, MultiModelConfig, ProviderConfig } from '@scope/multi-model-agent-core';
import { getBaseCapabilities } from '@scope/multi-model-agent-core/routing/capabilities';
import { findModelProfile, getEffectiveCostTier } from '@scope/multi-model-agent-core/routing/model-profiles';
import type { ModelProfile } from '@scope/multi-model-agent-core/routing/model-profiles';

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
  Use when requirements are unclear or judgment is required.

Optional 'effort' knob (per task):
- Only providers marked 'effort: supported' in the matrix honor this field.
- Use 'high' for reasoning-tier tasks when you want maximum depth,
  'medium' for balanced, 'low' for fast-but-shallow, 'none' to disable
  thinking entirely on providers that default it on. Omit the field on
  providers that do not support it.`;

function renderProviderBlock(
  name: string,
  config: ProviderConfig,
  capabilities: Capability[],
  profile: ModelProfile,
  costSource: 'config' | 'default',
): string {
  const cost = getEffectiveCostTier(config);
  const costSuffix = costSource === 'config' ? ' (from config)' : '';
  const effortLabel = profile.supportsEffort ? 'supported' : 'not supported';
  const lines = [
    `${name} (${config.model})`,
    `  tools: ${capabilities.join(', ')}`,
    `  tier: ${profile.tier} | cost: ${cost}${costSuffix} | effort: ${effortLabel}`,
    `  best for: ${profile.bestFor}`,
  ];
  if (profile.notes) {
    lines.push(`  note: ${profile.notes}`);
  }
  if (profile.avoidFor) {
    lines.push(`  avoid for: ${profile.avoidFor}`);
  }
  return lines.join('\n');
}

/**
 * Renders the full routing matrix for the MCP tool description.
 * Helps the consuming LLM understand provider capabilities and routing rules.
 */
export function renderProviderRoutingMatrix(config: MultiModelConfig): string {
  const blocks = Object.entries(config.providers).map(([name, providerConfig]) => {
    const capabilities = getBaseCapabilities(providerConfig);
    const profile = findModelProfile(providerConfig.model);
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

- [ ] **Step 1: Write packages/mcp/src/routing/render-provider-routing-matrix.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/src/routing/render-provider-routing-matrix.ts
git commit -m "feat(mcp): add routing/render-provider-routing-matrix.ts"
```

---

### Task 21: Create packages/mcp/src/cli.ts

**Files:**
- Create: `packages/mcp/src/cli.ts`

MCP CLI. **Owns config discovery** (--config, MULTI_MODEL_CONFIG, ~/.multi-model/config.json).

Imports `runTasks`, `TaskSpec`, types from `@scope/multi-model-agent-core`.

Imports `renderProviderRoutingMatrix` from local sibling.

```typescript
#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfigFromFile } from '@scope/multi-model-agent-core/config/load';
import { parseConfig } from '@scope/multi-model-agent-core/config/schema';
import { runTasks } from '@scope/multi-model-agent-core/run-tasks';
import type { TaskSpec } from '@scope/multi-model-agent-core';
import { renderProviderRoutingMatrix } from './routing/render-provider-routing-matrix.js';

export const SERVER_NAME = 'multi-model-agent';
export const SERVER_VERSION = '0.1.0';

export function buildTaskSchema(availableProviders: [string, ...string[]]) {
  return z.object({
    prompt: z.string().describe('Task prompt for the sub-agent'),
    provider: z.enum(availableProviders).describe('Provider name').optional(),
    tier: z.enum(['trivial', 'standard', 'reasoning'])
      .describe('Required quality tier.'),
    requiredCapabilities: z.array(z.enum([
      'file_read', 'file_write', 'grep', 'glob',
      'shell', 'web_search', 'web_fetch',
    ])).describe('Capabilities this task requires. Empty array if none.'),
    tools: z.enum(['none', 'full']).optional().describe('Tool access mode. Default: full'),
    maxTurns: z.number().int().positive().optional().describe('Max agent loop turns. Default: 200'),
    timeoutMs: z.number().int().positive().optional().describe('Timeout in ms. Default: 600000'),
    cwd: z.string().optional().describe('Working directory for file/shell tools'),
    effort: z.enum(['none', 'low', 'medium', 'high']).optional()
      .describe("Reasoning effort."),
    sandboxPolicy: z.enum(['none', 'cwd-only']).optional().describe('File-system confinement policy. Default: cwd-only'),
  });
}

export function buildMcpServer(config: Parameters<typeof runTasks>[1]) {
  const providerKeys = Object.keys(config.providers);
  if (providerKeys.length === 0) {
    throw new Error('buildMcpServer requires at least one configured provider.');
  }

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const availableProviders = providerKeys as [string, ...string[]];

  server.tool(
    'delegate_tasks',
    renderProviderRoutingMatrix(config),
    {
      tasks: z.array(buildTaskSchema(availableProviders)).describe('Array of tasks to execute in parallel'),
    },
    async ({ tasks }) => {
      const results = await runTasks(tasks as TaskSpec[], config);

      const response = {
        results: results.map((r, i) => ({
          provider: tasks[i].provider ?? '(auto)',
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

  return server;
}

/**
 * MCP CLI config discovery (owned by MCP, not core):
 * 1. --config <path> argument (explicit)
 * 2. MULTI_MODEL_CONFIG environment variable
 * 3. ~/.multi-model/config.json (default home-directory location)
 */
async function discoverConfig(): Promise<ReturnType<typeof parseConfig> extends Promise<infer T> ? T : never> {
  const args = process.argv.slice(2);

  // 1. Explicit --config
  const configFlagIdx = args.indexOf('--config');
  if (configFlagIdx >= 0 && args[configFlagIdx + 1]) {
    return loadConfigFromFile(args[configFlagIdx + 1]);
  }

  // 2. MULTI_MODEL_CONFIG env var (file path)
  const envPath = process.env.MULTI_MODEL_CONFIG;
  if (envPath) {
    return loadConfigFromFile(envPath);
  }

  // 3. ~/.multi-model/config.json
  const defaultPath = path.join(os.homedir(), '.multi-model', 'config.json');
  if (fs.existsSync(defaultPath)) {
    return loadConfigFromFile(defaultPath);
  }

  // Fallback: empty config
  return parseConfig({});
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] !== 'serve') {
    console.error('Usage: multi-model-agent serve [--config <path>]');
    process.exit(1);
  }

  const config = await discoverConfig();
  const providerNames = Object.keys(config.providers);

  if (providerNames.length === 0) {
    console.error('No providers configured. Create ~/.multi-model/config.json or pass --config <path>.');
    process.exit(1);
  }

  const server = buildMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main when executed directly
const thisFile = fileURLToPath(import.meta.url);
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(thisFile);
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 1: Write packages/mcp/src/cli.ts with config discovery owned by MCP**

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/src/cli.ts
git commit -m "feat(mcp): add cli.ts with buildMcpServer and MCP-owned config discovery"
```

---

### Task 22: Create packages/mcp/src/index.ts

**Files:**
- Create: `packages/mcp/src/index.ts`

```typescript
export { buildMcpServer, buildTaskSchema } from './cli.js';
export { renderProviderRoutingMatrix } from './routing/render-provider-routing-matrix.js';
```

- [ ] **Step 1: Write packages/mcp/src/index.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/mcp/src/index.ts
git commit -m "feat(mcp): add index.ts exporting buildMcpServer, buildTaskSchema"
```

---

## Phase 8: Root cleanup

### Task 23: Delete old src/, dist/, tsconfig.json

**Files:**
- Delete: `src/` (all contents)
- Delete: `dist/` (all contents)
- Delete: `tsconfig.json`

```bash
rm -rf src/ dist/ tsconfig.json
```

- [ ] **Step 1: Delete old package files**

```bash
rm -rf src/ dist/ tsconfig.json
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: remove old single-package src, dist, tsconfig.json"
```

---

## Phase 9: Tests

### Task 24: Migrate tests to use package paths

**Files:**
- Modify: all test files in `tests/`

Update imports:
- `from '../src/config.js'` → `from '@scope/multi-model-agent-core/config/load'`
- `from '../src/provider.js'` → `from '@scope/multi-model-agent-core'`
- `from '../src/delegate.js'` → `from '@scope/multi-model-agent-core/run-tasks'`
- `from '../src/types.js'` → `from '@scope/multi-model-agent-core'`
- `from '../src/routing/capabilities.js'` → `from '@scope/multi-model-agent-core/routing/capabilities'`
- `from '../src/routing/model-profiles.js'` → `from '@scope/multi-model-agent-core/routing/model-profiles'`
- `from '../src/routing/describe.js'` → `from '@scope/multi-model-agent-mcp/routing/render-provider-routing-matrix'`
- `from '../src/cli.js'` → `from '@scope/multi-model-agent-mcp'`

**Internal tests** (runners, tools, auth internals): may use relative paths like `../../packages/core/src/runners/openai-runner.ts` if testing internal details.

**Key behavior changes to test with new API:**
- `loadConfig` is gone — replaced by `loadConfigFromFile` (async) and `parseConfig` (sync)
- `DelegateTask` → `TaskSpec`
- `delegateAll` → `runTasks`
- `getEffectiveCapabilities` → `resolveTaskCapabilities`
- `ProviderConfig` is now a discriminated union — tests should use the new types

- [ ] **Step 1: Update each test file's imports**

Open each test file, find the import from `../src/...`, update to the appropriate package path.

- [ ] **Step 2: Commit after all test updates**

```bash
git add tests/
git commit -m "test: update imports to use package paths"
```

---

## Phase 10: Final verification

### Task 25: Build and verify tests pass

- [ ] **Step 1: npm run build**

Expected: Both packages build without TypeScript errors.

```bash
npm run build
```

- [ ] **Step 2: npm test**

Expected: All tests pass.

```bash
npm test
```

- [ ] **Step 3: If build or tests fail, diagnose and fix inline, then retry**

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify build and tests pass after monorepo restructure"
```

---

## Self-Review Checklist

- [ ] Core public API uses new names: `runTasks`, `TaskSpec`, `loadConfigFromFile`, `parseConfig`, `getBaseCapabilities`, `resolveTaskCapabilities`, `findModelProfile`, `getEffectiveCostTier`, `selectProviderForTask`, `getProviderEligibility`
- [ ] `ProviderConfig` is a discriminated union with `baseUrl` required on `OpenAICompatibleProviderConfig`
- [ ] Core `config/load.ts` has no auto-discovery (no MULTI_MODEL_CONFIG, no search paths)
- [ ] MCP `cli.ts` owns discovery order: `--config`, `MULTI_MODEL_CONFIG` env, `~/.multi-model/config.json`
- [ ] `packages/core/package.json` exports no runners/tools/auth subpaths
- [ ] `packages/mcp/package.json` has `bin.multi-model-agent` wired up
- [ ] Root `package.json` has `devDependencies` with `typescript` and `vitest`
- [ ] Root `src/`, `dist/`, `tsconfig.json` deleted
- [ ] No generated `.js` files checked in alongside `.ts` source
- [ ] All tests pass with `npm test`
