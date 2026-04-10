# Core + MCP Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the codebase into two packages — `@scope/multi-model-agent-core` (sub-agent orchestration engine) and `@scope/multi-model-agent-mcp` (MCP transport adapter). Core owns all policy and execution; MCP is thin glue.

**Architecture:** Monorepo under `packages/`. Core lives at `packages/core/src/`, MCP at `packages/mcp/src/`. All routing policy lives in core; `mcp` depends on `core` and imports `runTasks()`.

**Tech Stack:** TypeScript, ESM, Zod v4, Vitest, `@modelcontextprotocol/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `openai`

---

## Phase Map

| Phase | What | Key constraint |
|-------|------|---------------|
| 1 | Monorepo structure | All packages compile before any runner code |
| 2 | Core types + discriminated ProviderConfig | Tests written first (TDD) |
| 3 | Config split (schema + load) | `loadConfigFromFile` must not auto-discover home dir |
| 4 | Routing helpers | `getBaseCapabilities`, `resolveTaskCapabilities`, `getProviderEligibility`, `selectProviderForTask` |
| 5 | Core orchestration (run-tasks + provider) | `runTasks()` is the policy-enforcing entry point |
| 6 | Runners update | Only type/adapter changes, no behavior changes |
| 7 | MCP package | `buildMcpServer` calls core's `runTasks()` |
| 8 | Tests update + cleanup | All old tests updated to new names/types |

---

## Phase 1: Monorepo Structure

### Task 1: Root workspace setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "multi-model-agent",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 3: Create `packages/core/package.json`**

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
    "./config/load": {
      "types": "./dist/config/load.d.ts",
      "import": "./dist/config/load.js"
    },
    "./config/schema": {
      "types": "./dist/config/schema.d.ts",
      "import": "./dist/config/schema.js"
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
    "./run-tasks": {
      "types": "./dist/run-tasks.d.ts",
      "import": "./dist/run-tasks.js"
    },
    "./provider": {
      "types": "./dist/provider.d.ts",
      "import": "./dist/provider.js"
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

- [ ] **Step 4: Create `packages/mcp/package.json`**

```json
{
  "name": "@scope/multi-model-agent-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/cli.js",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "build": "tsc"
  },
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

- [ ] **Step 5: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 6: Create `packages/mcp/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 7: Verify workspace resolves**

Run: `npm install --workspaces`
Expected: installs without error; `node -e "require('./packages/core/package.json')"` would work but we use ESM so skip

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.base.json packages/
git commit -m "feat: add monorepo workspace structure"
```

---

## Phase 2: Core Types

### Task 2: Create `packages/core/src/types.ts`

**Files:**
- Create: `packages/core/src/types.ts`
- Test: `tests/core/types.test.ts` (new file)

- [ ] **Step 1: Create failing test `tests/core/types.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import type {
  TaskSpec,
  ProviderConfig,
  CodexProviderConfig,
  ClaudeProviderConfig,
  OpenAICompatibleProviderConfig,
  RunResult,
  RunOptions,
  MultiModelConfig,
  ProviderEligibility,
  EligibilityFailure,
  EligibilityFailureCheck,
} from '../../packages/core/src/types.js';

describe('TaskSpec', () => {
  it('accepts minimal valid task spec', () => {
    const task: TaskSpec = {
      prompt: 'do something',
      tier: 'standard',
      requiredCapabilities: [],
    };
    expect(task.prompt).toBe('do something');
    expect(task.tier).toBe('standard');
  });

  it('accepts all optional fields', () => {
    const task: TaskSpec = {
      prompt: 'x',
      provider: 'my-provider',
      tier: 'reasoning',
      requiredCapabilities: ['file_read'],
      tools: 'full',
      maxTurns: 50,
      timeoutMs: 120000,
      cwd: '/tmp',
      effort: 'high',
      sandboxPolicy: 'none',
    };
    expect(task.provider).toBe('my-provider');
    expect(task.effort).toBe('high');
  });

  it('tier is restricted to trivial | standard | reasoning', () => {
    // @ts-expect-error — invalid tier
    const task: TaskSpec = { prompt: 'x', tier: 'expert', requiredCapabilities: [] };
    expect(task.tier).toBeUndefined();
  });
});

describe('ProviderConfig discriminated union', () => {
  it('narrowing CodexProviderConfig has no baseUrl field', () => {
    const cfg: CodexProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    expect(cfg.type).toBe('codex');
    // @ts-expect-error — baseUrl not valid on codex
    const _url: string = cfg.baseUrl;
  });

  it('narrowing ClaudeProviderConfig has no apiKey field', () => {
    const cfg: ClaudeProviderConfig = { type: 'claude', model: 'claude-opus-4-6' };
    expect(cfg.type).toBe('claude');
    // @ts-expect-error — apiKey not valid on claude
    const _key: string = cfg.apiKey;
  });

  it('narrowing OpenAICompatibleProviderConfig requires baseUrl', () => {
    // @ts-expect-error — baseUrl is required
    const cfg: OpenAICompatibleProviderConfig = { type: 'openai-compatible', model: 'MiniMax-M2' };
    const valid: OpenAICompatibleProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
    };
    expect(valid.baseUrl).toBe('https://api.example.com/v1');
  });

  it('ProviderConfig union accepts each variant', () => {
    const configs: ProviderConfig[] = [
      { type: 'codex', model: 'gpt-5-codex' },
      { type: 'claude', model: 'claude-opus-4-6' },
      { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1' },
    ];
    expect(configs).toHaveLength(3);
  });
});

describe('EligibilityFailureCheck is extensible', () => {
  it('accepts known check values', () => {
    const failure: EligibilityFailure = {
      check: 'capability',
      detail: 'shell',
      message: 'shell not available under sandboxPolicy cwd-only',
    };
    expect(failure.check).toBe('capability');
  });

  it('accepts arbitrary string check', () => {
    const failure: EligibilityFailure = {
      check: 'my_custom_check',
      detail: 'something',
      message: 'custom',
    };
    expect(failure.check).toBe('my_custom_check');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/types.test.ts`
Expected: FAIL — types file does not exist

- [ ] **Step 3: Write `packages/core/src/types.ts`**

```typescript
// === Capability types ===

export type Capability =
  | 'file_read'
  | 'file_write'
  | 'grep'
  | 'glob'
  | 'shell'
  | 'web_search'
  | 'web_fetch';

export type ToolMode = 'none' | 'full';
export type SandboxPolicy = 'none' | 'cwd-only';
export type Effort = 'none' | 'low' | 'medium' | 'high';
export type Tier = 'trivial' | 'standard' | 'reasoning';
export type CostTier = 'free' | 'low' | 'medium' | 'high';
export type RunStatus = 'ok' | 'error' | 'timeout' | 'max_turns';

// === Result types ===

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number | null;
}

export interface RunResult {
  output: string;
  status: RunStatus;
  usage: TokenUsage;
  turns: number;
  files: string[];
  error?: string;
}

// === Config types ===

export interface MultiModelConfig {
  providers: Record<string, ProviderConfig>;
  defaults: {
    maxTurns: number;
    timeoutMs: number;
    tools: ToolMode;
  };
}

// === Provider configs (discriminated union) ===

export interface CodexProviderConfig {
  type: 'codex';
  model: string;
  effort?: Effort;
  maxTurns?: number;
  timeoutMs?: number;
  sandboxPolicy?: SandboxPolicy;
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[];
  costTier?: CostTier;
}

export interface ClaudeProviderConfig {
  type: 'claude';
  model: string;
  effort?: Effort;
  maxTurns?: number;
  timeoutMs?: number;
  sandboxPolicy?: SandboxPolicy;
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[];
  costTier?: CostTier;
}

export interface OpenAICompatibleProviderConfig {
  type: 'openai-compatible';
  model: string;
  baseUrl: string; // required — no silent OpenAI default
  apiKey?: string;
  apiKeyEnv?: string;
  effort?: Effort;
  maxTurns?: number;
  timeoutMs?: number;
  sandboxPolicy?: SandboxPolicy;
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[];
  costTier?: CostTier;
}

export type ProviderConfig =
  | CodexProviderConfig
  | ClaudeProviderConfig
  | OpenAICompatibleProviderConfig;

// === Run options ===

export interface RunOptions {
  tools?: ToolMode;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  effort?: Effort;
  sandboxPolicy?: SandboxPolicy;
}

// === Task spec ===

export interface TaskSpec {
  prompt: string;
  /** Provider name. If omitted, core auto-selects. */
  provider?: string;
  tier: Tier;
  requiredCapabilities: Capability[];
  tools?: ToolMode;
  maxTurns?: number;
  timeoutMs?: number;
  cwd?: string;
  effort?: Effort;
  sandboxPolicy?: SandboxPolicy;
}

// === Provider (low-level API) ===

export interface Provider {
  readonly name: string;
  readonly config: ProviderConfig;
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
}

// === Eligibility types ===

export type EligibilityFailureCheck =
  | 'capability'
  | 'tier'
  | 'tool_mode'
  | 'provider_not_found'
  | 'unsupported_provider_type'
  | 'missing_required_field'
  | string;

export interface EligibilityFailure {
  check: EligibilityFailureCheck;
  detail: string;
  message: string;
}

export interface ProviderEligibility {
  name: string;
  config: ProviderConfig;
  eligible: boolean;
  reasons: EligibilityFailure[];
}

// === Internal helper for partial progress ===

export interface PartialProgress {
  files: string[];
  usage?: Partial<TokenUsage>;
  turns?: number;
}

export async function withTimeout(
  promise: Promise<RunResult>,
  timeoutMs: number,
  partialProgress: () => PartialProgress,
  abortController?: AbortController,
): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout>;

  const timeout = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      abortController?.abort();
      const progress = partialProgress();
      resolve({
        output: 'Agent timed out.',
        status: 'timeout',
        usage: {
          inputTokens: progress.usage?.inputTokens ?? 0,
          outputTokens: progress.usage?.outputTokens ?? 0,
          totalTokens: progress.usage?.totalTokens ?? 0,
          costUSD: progress.usage?.costUSD ?? null,
        },
        turns: progress.turns ?? 0,
        files: progress.files,
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts tests/core/types.test.ts
git commit -m "feat(core): add discriminated ProviderConfig and TaskSpec types"
```

---

## Phase 3: Config Split

### Task 3: `packages/core/src/config/schema.ts`

**Files:**
- Create: `packages/core/src/config/schema.ts`
- Test: `tests/core/config/schema.test.ts` (new file)

- [ ] **Step 1: Write failing test `tests/core/config/schema.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../../packages/core/src/config/schema.js';
import type { MultiModelConfig } from '../../../packages/core/src/types.js';

describe('parseConfig', () => {
  it('accepts a valid minimal config', () => {
    const raw = {
      providers: {
        codex: { type: 'codex', model: 'gpt-5-codex' },
      },
    };
    const config = parseConfig(raw);
    expect(config.providers.codex.type).toBe('codex');
    expect(config.defaults.maxTurns).toBe(200);
    expect(config.defaults.timeoutMs).toBe(600000);
    expect(config.defaults.tools).toBe('full');
  });

  it('applies all defaults when only providers given', () => {
    const config = parseConfig({
      providers: { claude: { type: 'claude', model: 'claude-opus-4-6' } },
    });
    expect(config.defaults.maxTurns).toBe(200);
    expect(config.defaults.tools).toBe('full');
    expect(config.defaults.timeoutMs).toBe(600000);
  });

  it('rejects openai-compatible without baseUrl', () => {
    expect(() =>
      parseConfig({ providers: { bad: { type: 'openai-compatible', model: 'x' } as any } }),
    ).toThrow(/baseUrl.*required/i);
  });

  it('rejects invalid provider type', () => {
    expect(() =>
      parseConfig({ providers: { x: { type: 'invalid', model: 'y' } as any } }),
    ).toThrow();
  });

  it('rejects maxTurns <= 0', () => {
    expect(() => parseConfig({ providers: {}, defaults: { maxTurns: 0 } } as any)).toThrow();
  });

  it('rejects negative timeoutMs', () => {
    expect(() => parseConfig({ providers: {}, defaults: { timeoutMs: -1 } } as any)).toThrow();
  });

  it('rejects invalid costTier', () => {
    expect(() =>
      parseConfig({
        providers: { x: { type: 'codex', model: 'y', costTier: 'gigantic' } as any },
      }),
    ).toThrow();
  });

  it('rejects invalid effort', () => {
    expect(() =>
      parseConfig({
        providers: { x: { type: 'claude', model: 'y', effort: 'ultra' } as any },
      }),
    ).toThrow();
  });

  it('accepts openai-compatible with baseUrl', () => {
    const config = parseConfig({
      providers: {
        oai: {
          type: 'openai-compatible',
          model: 'MiniMax-M2',
          baseUrl: 'https://api.example.com/v1',
        },
      },
    });
    expect(config.providers.oai.type).toBe('openai-compatible');
  });

  it('rejects provider-level maxTurns <= 0', () => {
    expect(() =>
      parseConfig({
        providers: { x: { type: 'codex', model: 'y', maxTurns: -1 } as any },
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/config/schema.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write `packages/core/src/config/schema.ts`**

```typescript
import { z } from 'zod';

const providerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('codex'),
    model: z.string(),
    effort: z.enum(['none', 'low', 'medium', 'high']).optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    sandboxPolicy: z.enum(['none', 'cwd-only']).optional(),
    hostedTools: z.array(z.enum(['web_search', 'image_generation', 'code_interpreter'])).optional(),
    costTier: z.enum(['free', 'low', 'medium', 'high']).optional(),
  }),
  z.object({
    type: z.literal('claude'),
    model: z.string(),
    effort: z.enum(['none', 'low', 'medium', 'high']).optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    sandboxPolicy: z.enum(['none', 'cwd-only']).optional(),
    hostedTools: z.array(z.enum(['web_search', 'image_generation', 'code_interpreter'])).optional(),
    costTier: z.enum(['free', 'low', 'medium', 'high']).optional(),
  }),
  z.object({
    type: z.literal('openai-compatible'),
    model: z.string(),
    baseUrl: z.string().min(1, 'baseUrl is required for openai-compatible providers'),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    effort: z.enum(['none', 'low', 'medium', 'high']).optional(),
    maxTurns: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    sandboxPolicy: z.enum(['none', 'cwd-only']).optional(),
    hostedTools: z.array(z.enum(['web_search', 'image_generation', 'code_interpreter'])).optional(),
    costTier: z.enum(['free', 'low', 'medium', 'high']).optional(),
  }),
]);

const defaultsSchema = z.object({
  maxTurns: z.number().int().positive().default(200),
  timeoutMs: z.number().int().positive().default(600000),
  tools: z.enum(['none', 'full']).default('full'),
});

export const configSchema = z.object({
  providers: z.record(z.string(), providerSchema),
  defaults: defaultsSchema.optional().default({}),
});

export type RawConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown) {
  return configSchema.parse(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts tests/core/config/schema.test.ts
git commit -m "feat(core): add Zod schema and parseConfig"
```

---

### Task 4: `packages/core/src/config/load.ts`

**Files:**
- Create: `packages/core/src/config/load.ts`
- Test: `tests/core/config/load.test.ts` (new file)

- [ ] **Step 1: Write failing test `tests/core/config/load.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfigFromFile } from '../../../packages/core/src/config/load.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('loadConfigFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mma-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and parses a valid config file', () => {
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      providers: {
        codex: { type: 'codex', model: 'gpt-5-codex' },
      },
    }));
    const config = loadConfigFromFile(cfgPath);
    expect(config.providers.codex.type).toBe('codex');
    expect(config.defaults.maxTurns).toBe(200);
  });

  it('throws when file does not exist', () => {
    expect(() => loadConfigFromFile(path.join(tmpDir, 'nonexistent.json'))).toThrow(
      /file not found/i,
    );
  });

  it('propagates Zod validation errors', () => {
    const cfgPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      providers: { bad: { type: 'openai-compatible', model: 'x' } },
    }));
    expect(() => loadConfigFromFile(cfgPath)).toThrow(/baseUrl.*required/i);
  });

  it('applies defaults from schema', () => {
    const cfgPath = path.join(tmpDir, 'minimal.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      providers: { claude: { type: 'claude', model: 'claude-opus-4-6' } },
    }));
    const config = loadConfigFromFile(cfgPath);
    expect(config.defaults.timeoutMs).toBe(600000);
    expect(config.defaults.tools).toBe('full');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/config/load.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write `packages/core/src/config/load.ts`**

```typescript
import fs from 'fs/promises';
import { parseConfig } from './schema.js';
import type { MultiModelConfig } from '../types.js';

/**
 * Load and parse a config file from disk.
 * Opt-in — no automatic home-directory discovery.
 * Use parseConfig() directly for in-memory config.
 */
export async function loadConfigFromFile(filePath: string): Promise<MultiModelConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Config file is not valid JSON: ${filePath}`);
  }
  return parseConfig(parsed);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/config/load.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/load.ts tests/core/config/load.test.ts
git commit -m "feat(core): add loadConfigFromFile"
```

---

## Phase 4: Routing Helpers

### Task 5: `packages/core/src/routing/capabilities.ts` (rename `getCapabilities` → `getBaseCapabilities`)

**Files:**
- Modify: `packages/core/src/routing/capabilities.ts` (rename function)
- Test: `tests/core/routing/capabilities.test.ts` (update existing test imports/names)

- [ ] **Step 1: Update `tests/routing/capabilities.test.ts` imports**

Change import from `getCapabilities` to `getBaseCapabilities`.

Change all test names: `describe('getCapabilities'` → `describe('getBaseCapabilities').

Change all call sites: `getCapabilities(...)` → `getBaseCapabilities(...)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/routing/capabilities.test.ts`
Expected: FAIL — getCapabilities not found (or getBaseCapabilities not yet exported)

- [ ] **Step 3: Update `packages/core/src/routing/capabilities.ts`**

Rename `getCapabilities` to `getBaseCapabilities` in the file. The current file content stays the same, only the export name changes.

```typescript
// (same content as existing src/routing/capabilities.ts — only export name changes)
export function getBaseCapabilities(config: ProviderConfig): Capability[] {
  // ... existing implementation unchanged ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/routing/capabilities.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routing/capabilities.ts tests/routing/capabilities.test.ts
git commit -m "feat(core): rename getCapabilities → getBaseCapabilities"
```

---

### Task 6: `packages/core/src/routing/model-profiles.ts` (rename exports)

**Files:**
- Modify: `packages/core/src/routing/model-profiles.ts` (rename exports)
- Test: `tests/routing/model-profiles.test.ts` (update imports/names)

- [ ] **Step 1: Update `tests/routing/model-profiles.test.ts`**

Change imports:
```typescript
import { findModelProfile, getEffectiveCostTier } from '../../src/routing/model-profiles.js';
```
Change all call sites: `findProfile` → `findModelProfile`, `effectiveCost` → `getEffectiveCostTier`.
Update `describe('findProfile'` → `describe('findModelProfile'`.
Update `describe('effectiveCost'` → `describe('getEffectiveCostTier'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/routing/model-profiles.test.ts`
Expected: FAIL — old names not found

- [ ] **Step 3: Update `packages/core/src/routing/model-profiles.ts` — rename functions in-place**

In the existing file, rename:
- `findProfile` → `findModelProfile`
- `effectiveCost` → `getEffectiveCostTier`

Do NOT add aliases or re-exports. The old names are deleted.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/routing/model-profiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routing/model-profiles.ts tests/routing/model-profiles.test.ts
git commit -m "feat(core): export findModelProfile and getEffectiveCostTier"
```

---

### Task 7: `packages/core/src/routing/resolve-task-capabilities.ts` (new file)

**Files:**
- Create: `packages/core/src/routing/resolve-task-capabilities.ts`
- Test: `tests/core/routing/resolve-task-capabilities.test.ts` (new file)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { resolveTaskCapabilities } from '../../../packages/core/src/routing/resolve-task-capabilities.js';
import type { CodexProviderConfig, ClaudeProviderConfig, OpenAICompatibleProviderConfig } from '../../../packages/core/src/types.js';

describe('resolveTaskCapabilities', () => {
  it('returns empty array when tools is none', () => {
    const cfg: CodexProviderConfig = { type: 'codex', model: 'gpt-5-codex' };
    const caps = resolveTaskCapabilities(cfg, { tools: 'none' });
    expect(caps).toEqual([]);
  });

  it('returns base capabilities when tools is full and no overrides', () => {
    const cfg: ClaudeProviderConfig = { type: 'claude', model: 'claude-opus-4-6' };
    const caps = resolveTaskCapabilities(cfg, { tools: 'full' });
    expect(caps).toContain('file_read');
    expect(caps).toContain('web_search');
    expect(caps).toContain('web_fetch');
  });

  it('includes shell when sandboxPolicy override is none', () => {
    const cfg: ClaudeProviderConfig = { type: 'claude', model: 'claude-opus-4-6' };
    const caps = resolveTaskCapabilities(cfg, { tools: 'full', sandboxPolicy: 'none' });
    expect(caps).toContain('shell');
  });

  it('excludes shell when per-task sandboxPolicy is cwd-only even if provider allows it', () => {
    const cfg: OpenAICompatibleProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
      sandboxPolicy: 'none',
    };
    const caps = resolveTaskCapabilities(cfg, { tools: 'full', sandboxPolicy: 'cwd-only' });
    expect(caps).not.toContain('shell');
  });

  it('returns file capabilities only for openai-compatible with no hosted tools', () => {
    const cfg: OpenAICompatibleProviderConfig = {
      type: 'openai-compatible',
      model: 'MiniMax-M2',
      baseUrl: 'https://api.example.com/v1',
    };
    const caps = resolveTaskCapabilities(cfg, { tools: 'full' });
    expect(caps).toContain('file_read');
    expect(caps).not.toContain('web_search');
    expect(caps).not.toContain('web_fetch');
  });

  it('includes web_search from hostedTools for openai-compatible', () => {
    const cfg: OpenAICompatibleProviderConfig = {
      type: 'openai-compatible',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com/v1',
      hostedTools: ['web_search'],
    };
    const caps = resolveTaskCapabilities(cfg, { tools: 'full' });
    expect(caps).toContain('web_search');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/routing/resolve-task-capabilities.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write `packages/core/src/routing/resolve-task-capabilities.ts`**

```typescript
import { getBaseCapabilities } from './capabilities.js';
import type { Capability, ProviderConfig, RunOptions } from '../types.js';

/**
 * Returns the capabilities a task will actually have at runtime.
 * Unlike getBaseCapabilities (static per-provider), this accounts for
 * per-task overrides: tools mode and sandboxPolicy.
 */
export function resolveTaskCapabilities(
  providerConfig: ProviderConfig,
  options: Pick<RunOptions, 'tools' | 'sandboxPolicy'>,
): Capability[] {
  if (options.tools === 'none') return [];

  const caps = getBaseCapabilities(providerConfig);

  const effectiveSandbox = options.sandboxPolicy ?? providerConfig.sandboxPolicy;
  if (effectiveSandbox === 'none' && !caps.includes('shell')) {
    caps.push('shell');
  } else if (effectiveSandbox === 'cwd-only') {
    return caps.filter((c) => c !== 'shell');
  }

  return caps;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/routing/resolve-task-capabilities.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routing/resolve-task-capabilities.ts tests/core/routing/resolve-task-capabilities.test.ts
git commit -m "feat(core): add resolveTaskCapabilities"
```

---

### Task 8: `packages/core/src/routing/get-provider-eligibility.ts`

**Files:**
- Create: `packages/core/src/routing/get-provider-eligibility.ts`
- Test: `tests/core/routing/get-provider-eligibility.test.ts` (new file)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { getProviderEligibility } from '../../../packages/core/src/routing/get-provider-eligibility.js';
import { parseConfig } from '../../../packages/core/src/config/schema.js';

describe('getProviderEligibility', () => {
  it('marks all providers eligible when requirements are satisfied', () => {
    const config = parseConfig({
      providers: {
        codex: { type: 'codex', model: 'gpt-5-codex' },
        claude: { type: 'claude', model: 'claude-opus-4-6' },
      },
    });
    const task = { prompt: 'x', tier: 'standard' as const, requiredCapabilities: [] as const };
    const reports = getProviderEligibility(task, config);
    expect(reports).toHaveLength(2);
    expect(reports.every((r) => r.eligible)).toBe(true);
  });

  it('marks provider ineligible for missing requiredCapability', () => {
    const config = parseConfig({
      providers: {
        minimax: {
          type: 'openai-compatible',
          model: 'MiniMax-M2',
          baseUrl: 'https://api.example.com/v1',
        },
      },
    });
    const task = {
      prompt: 'x',
      tier: 'standard' as const,
      requiredCapabilities: ['web_search'] as const,
    };
    const reports = getProviderEligibility(task, config);
    expect(reports[0].eligible).toBe(false);
    expect(reports[0].reasons.some((r) => r.check === 'capability' && r.detail === 'web_search')).toBe(true);
  });

  it('marks provider ineligible when tier is below task tier', () => {
    const config = parseConfig({
      providers: {
        minimax: {
          type: 'openai-compatible',
          model: 'MiniMax-M2', // tier: standard
          baseUrl: 'https://api.example.com/v1',
        },
      },
    });
    const task = { prompt: 'x', tier: 'reasoning' as const, requiredCapabilities: [] as const };
    const reports = getProviderEligibility(task, config);
    expect(reports[0].eligible).toBe(false);
    expect(reports[0].reasons.some((r) => r.check === 'tier')).toBe(true);
  });

  it('marks openai-compatible with baseUrl missing as ineligible with correct check type', () => {
    const config = parseConfig({
      providers: {
        bad: { type: 'openai-compatible', model: 'x', baseUrl: '' } as any,
      },
    });
    const task = { prompt: 'x', tier: 'standard' as const, requiredCapabilities: [] as const };
    const reports = getProviderEligibility(task, config);
    // After schema validation this can't exist, but test the info returned
    expect(reports[0].name).toBe('bad');
  });

  it('returns reports for all providers, not just eligible ones', () => {
    const config = parseConfig({
      providers: {
        ok: { type: 'codex', model: 'gpt-5-codex' },
        no: { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1' },
      },
    });
    const task = { prompt: 'x', tier: 'reasoning' as const, requiredCapabilities: [] as const };
    const reports = getProviderEligibility(task, config);
    expect(reports).toHaveLength(2);
    expect(reports.find((r) => r.name === 'ok')?.eligible).toBe(true);
    expect(reports.find((r) => r.name === 'no')?.eligible).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/routing/get-provider-eligibility.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write `packages/core/src/routing/get-provider-eligibility.ts`**

```typescript
import { resolveTaskCapabilities } from './resolve-task-capabilities.js';
import { findModelProfile } from './model-profiles.js';
import type { MultiModelConfig, ProviderEligibility, EligibilityFailure, TaskSpec } from '../types.js';

const TIER_ORDER: Record<string, number> = { trivial: 0, standard: 1, reasoning: 2 };

export function getProviderEligibility(
  task: TaskSpec,
  config: MultiModelConfig,
): ProviderEligibility[] {
  return Object.entries(config.providers).map(([name, providerConfig]) => {
    const reasons: EligibilityFailure[] = [];

    // Capability check
    const available = resolveTaskCapabilities(providerConfig, {
      tools: task.tools ?? config.defaults.tools,
      sandboxPolicy: task.sandboxPolicy,
    });
    const missing = task.requiredCapabilities.filter((c) => !available.includes(c));
    if (missing.length > 0) {
      reasons.push({
        check: 'capability',
        detail: missing.join(', '),
        message: `missing capabilities: ${missing.join(', ')}`,
      });
    }

    // Tier check
    const profile = findModelProfile(providerConfig.model);
    const taskTierRank = TIER_ORDER[task.tier] ?? 0;
    const providerTierRank = TIER_ORDER[profile.tier] ?? 0;
    if (providerTierRank < taskTierRank) {
      reasons.push({
        check: 'tier',
        detail: `${profile.tier} < ${task.tier}`,
        message: `provider tier '${profile.tier}' is below task tier '${task.tier}'`,
      });
    }

    // Tool mode check
    if (task.tools === 'none' && task.requiredCapabilities.length > 0) {
      reasons.push({
        check: 'tool_mode',
        detail: 'tools: none',
        message: 'tools disabled but requiredCapabilities specified',
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/routing/get-provider-eligibility.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routing/get-provider-eligibility.ts tests/core/routing/get-provider-eligibility.test.ts
git commit -m "feat(core): add getProviderEligibility"
```

---

### Task 9: `packages/core/src/routing/select-provider-for-task.ts`

**Files:**
- Create: `packages/core/src/routing/select-provider-for-task.ts`
- Test: `tests/core/routing/select-provider-for-task.test.ts` (new file)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { selectProviderForTask } from '../../../packages/core/src/routing/select-provider-for-task.js';
import { parseConfig } from '../../../packages/core/src/config/schema.js';

describe('selectProviderForTask', () => {
  it('returns explicitly specified provider config', () => {
    const config = parseConfig({
      providers: {
        codex: { type: 'codex', model: 'gpt-5-codex' },
      },
    });
    const task = { prompt: 'x', tier: 'standard' as const, requiredCapabilities: [], provider: 'codex' };
    const selected = selectProviderForTask(task, config);
    expect(selected.type).toBe('codex');
  });

  it('throws when explicitly specified provider does not exist', () => {
    const config = parseConfig({
      providers: { codex: { type: 'codex', model: 'gpt-5-codex' } },
    });
    const task = { prompt: 'x', tier: 'standard' as const, requiredCapabilities: [], provider: 'unknown' };
    expect(() => selectProviderForTask(task, config)).toThrow(/unknown/);
  });

  it('auto-selects cheapest eligible provider when provider is omitted', () => {
    const config = parseConfig({
      providers: {
        expensive: { type: 'claude', model: 'claude-opus-4-6', costTier: 'high' as const },
        cheap: { type: 'codex', model: 'gpt-5-codex', costTier: 'medium' as const },
      },
    });
    const task = { prompt: 'x', tier: 'reasoning' as const, requiredCapabilities: [] };
    const selected = selectProviderForTask(task, config);
    expect(selected.type).toBe('codex'); // cheaper
  });

  it('excludes ineligible providers from auto-selection', () => {
    const config = parseConfig({
      providers: {
        reasoning: { type: 'claude', model: 'claude-opus-4-6' }, // tier: reasoning
        standard: { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1', costTier: 'free' as const },
      },
    });
    // Task needs reasoning tier; standard provider should be excluded
    const task = { prompt: 'x', tier: 'reasoning' as const, requiredCapabilities: [] };
    const selected = selectProviderForTask(task, config);
    expect(selected.type).toBe('claude');
  });

  it('uses provider name as tiebreaker (ascending ASCII)', () => {
    const config = parseConfig({
      providers: {
        b: { type: 'claude', model: 'claude-opus-4-6', costTier: 'medium' as const },
        a: { type: 'claude', model: 'claude-sonnet-4-6', costTier: 'medium' as const },
      },
    });
    const task = { prompt: 'x', tier: 'standard' as const, requiredCapabilities: [] };
    const selected = selectProviderForTask(task, config);
    expect(selected.type).toBe('claude'); // 'a' sorts before 'b'
  });

  it('throws when no eligible provider exists', () => {
    const config = parseConfig({
      providers: {
        minimax: { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1' },
      },
    });
    const task = { prompt: 'x', tier: 'reasoning' as const, requiredCapabilities: ['web_search'] };
    expect(() => selectProviderForTask(task, config)).toThrow(/no eligible provider/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/routing/select-provider-for-task.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write `packages/core/src/routing/select-provider-for-task.ts`**

```typescript
import { getProviderEligibility } from './get-provider-eligibility.js';
import { findModelProfile, getEffectiveCostTier } from './model-profiles.js';
import type { MultiModelConfig, ProviderConfig, TaskSpec } from '../types.js';

const COST_ORDER: Record<string, number> = { free: 0, low: 1, medium: 2, high: 3 };

export function selectProviderForTask(
  task: TaskSpec,
  config: MultiModelConfig,
): ProviderConfig {
  // If provider is explicitly specified, validate and return it
  if (task.provider) {
    const provider = config.providers[task.provider];
    if (!provider) {
      throw new Error(`Provider "${task.provider}" not found in config. Available: ${Object.keys(config.providers).sort().join(', ')}`);
    }
    return provider;
  }

  // Auto-select: filter to eligible, sort by cost, then name
  const allReports = getProviderEligibility(task, config);
  const eligible = allReports.filter((r) => r.eligible);

  if (eligible.length === 0) {
    const summary = allReports
      .map((r) => `  ${r.name}: ${r.reasons.map((f) => f.message).join('; ')}`)
      .join('\n');
    throw new Error(`No eligible provider for task "${task.prompt.slice(0, 50)}..."\n${summary}`);
  }

  // Sort by cost tier asc, then provider name asc
  eligible.sort((a, b) => {
    const costA = COST_ORDER[getEffectiveCostTier(a.config)] ?? 99;
    const costB = COST_ORDER[getEffectiveCostTier(b.config)] ?? 99;
    if (costA !== costB) return costA - costB;
    return a.name.localeCompare(b.name);
  });

  return eligible[0].config;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/routing/select-provider-for-task.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routing/select-provider-for-task.ts tests/core/routing/select-provider-for-task.test.ts
git commit -m "feat(core): add selectProviderForTask"
```

---

## Phase 5: Core Orchestration

### Task 10: `packages/core/src/provider.ts`

**Files:**
- Create: `packages/core/src/provider.ts` (rewrite for new types)
- Test: update `tests/provider.test.ts` imports

The existing `provider.ts` logic stays essentially the same, but:
- Import types from `./types.js`
- Export `createProvider` as-is (signature unchanged)
- Update `MultiModelConfig` type import to use new types

- [ ] **Step 1: Run existing provider tests to confirm baseline**

Run: `npm test -- tests/provider.test.ts`
Expected: PASS (before changes)

- [ ] **Step 2: Rewrite `packages/core/src/provider.ts`**

```typescript
import type { Provider, MultiModelConfig, RunOptions, RunResult, ProviderConfig } from './types.js';

export function createProvider(name: string, config: MultiModelConfig): Provider {
  const providerConfig = config.providers[name];
  if (!providerConfig) {
    const available = Object.keys(config.providers).sort().join(', ');
    throw new Error(`Provider "${name}" not found in config. Available: ${available}`);
  }

  const defaults = config.defaults;

  const run = async (prompt: string, options: RunOptions = {}): Promise<RunResult> => {
    try {
      switch (providerConfig.type) {
        case 'codex': {
          const { runCodex } = await import('./runners/codex-runner.js');
          return await runCodex(prompt, options, providerConfig, defaults);
        }

        case 'claude': {
          const { runClaude } = await import('./runners/claude-runner.js');
          return await runClaude(prompt, options, providerConfig, defaults);
        }

        case 'openai-compatible': {
          const { runOpenAI } = await import('./runners/openai-runner.js');
          const { default: OpenAI } = await import('openai');
          const apiKey = providerConfig.apiKey
            ?? (providerConfig.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : undefined);
          const client = new OpenAI({
            apiKey: apiKey || 'not-needed',
            baseURL: providerConfig.baseUrl,
          });
          return await runOpenAI(prompt, options, { client, providerConfig, defaults });
        }

        default: {
          const _exhaustive: never = providerConfig;
          throw new Error(`Unknown provider type: ${_exhaustive}`);
        }
      }
    } catch (err) {
      return {
        output: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        files: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return { name, config: providerConfig, run };
}
```

- [ ] **Step 3: Run tests to verify it still passes**

Run: `npm test -- tests/provider.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/provider.ts
git commit -m "feat(core): rewrite provider.ts with new types"
```

---

### Task 11: `packages/core/src/run-tasks.ts`

**Files:**
- Create: `packages/core/src/run-tasks.ts`
- Test: `tests/core/run-tasks.test.ts` (new file)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runTasks } from '../../../packages/core/src/run-tasks.js';
import { parseConfig } from '../../../packages/core/src/config/schema.js';
import type { TaskSpec, Provider } from '../../../packages/core/src/types.js';

function mockProvider(name: string, output = 'ok') {
  return {
    name,
    config: { type: 'codex' as const, model: 'gpt-5-codex' },
    run: vi.fn().mockResolvedValue({
      output,
      status: 'ok' as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
      turns: 1,
      files: [],
    }),
  };
}

describe('runTasks', () => {
  it('runs all tasks in parallel and returns results in input order', async () => {
    const config = parseConfig({
      providers: {
        a: { type: 'codex', model: 'gpt-5-codex' },
        b: { type: 'claude', model: 'claude-opus-4-6' },
      },
    });
    const pA = mockProvider('a', 'result-a');
    const pB = mockProvider('b', 'result-b');
    const tasks: TaskSpec[] = [
      { prompt: 'task a', tier: 'standard', requiredCapabilities: [], provider: 'a' },
      { prompt: 'task b', tier: 'reasoning', requiredCapabilities: [], provider: 'b' },
    ];

    const results = await runTasks(tasks, config, { a: pA, b: pB });

    expect(results).toHaveLength(2);
    expect(results[0].output).toBe('result-a');
    expect(results[1].output).toBe('result-b');
  });

  it('isolates errors per task', async () => {
    const config = parseConfig({
      providers: {
        good: { type: 'codex', model: 'gpt-5-codex' },
        bad: { type: 'claude', model: 'claude-opus-4-6' },
      },
    });
    const pGood = mockProvider('good');
    const pBad = {
      name: 'bad',
      config: { type: 'claude', model: 'claude-opus-4-6' },
      run: vi.fn().mockRejectedValue(new Error('auth failure')),
    };
    const tasks: TaskSpec[] = [
      { prompt: 't1', tier: 'standard', requiredCapabilities: [], provider: 'good' },
      { prompt: 't2', tier: 'reasoning', requiredCapabilities: [], provider: 'bad' },
    ];

    const results = await runTasks(tasks, config, { good: pGood, bad: pBad });

    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('error');
    expect(results[1].error).toBe('auth failure');
  });

  it('auto-selects provider when task.provider is omitted', async () => {
    const config = parseConfig({
      providers: {
        codex: { type: 'codex', model: 'gpt-5-codex' },
      },
    });
    const pCodex = mockProvider('codex', 'auto-selected');
    const tasks: TaskSpec[] = [
      { prompt: 't', tier: 'standard', requiredCapabilities: [] },
    ];

    const results = await runTasks(tasks, config, { codex: pCodex });

    expect(pCodex.run).toHaveBeenCalled();
    expect(results[0].output).toBe('auto-selected');
  });

  it('returns error result when no eligible provider', async () => {
    const config = parseConfig({
      providers: {
        minimax: { type: 'openai-compatible', model: 'MiniMax-M2', baseUrl: 'https://api.example.com/v1' },
      },
    });
    const tasks: TaskSpec[] = [
      { prompt: 't', tier: 'reasoning', requiredCapabilities: ['web_search'] },
    ];

    const results = await runTasks(tasks, config, {});

    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/no eligible provider/i);
  });

  it('passes all options through to provider.run', async () => {
    const config = parseConfig({
      providers: {
        codex: { type: 'codex', model: 'gpt-5-codex' },
      },
    });
    const p = mockProvider('codex');
    const tasks: TaskSpec[] = [
      { prompt: 't', tier: 'standard', requiredCapabilities: [], tools: 'full', maxTurns: 50, cwd: '/tmp' },
    ];

    await runTasks(tasks, config, { codex: p });

    expect(p.run).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ tools: 'full', maxTurns: 50, cwd: '/tmp' }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/core/run-tasks.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write `packages/core/src/run-tasks.ts`**

```typescript
import { selectProviderForTask } from './routing/select-provider-for-task.js';
import { createProvider } from './provider.js';
import type { TaskSpec, MultiModelConfig, RunResult, Provider } from './types.js';

export interface RunTasksOptions {
  /** Override provider creation. Key is provider name. Used for testing injection. */
  providers?: Record<string, Provider>;
}

async function executeTask(
  task: TaskSpec,
  provider: Provider,
): Promise<RunResult> {
  return provider.run(task.prompt, {
    tools: task.tools,
    maxTurns: task.maxTurns,
    timeoutMs: task.timeoutMs,
    cwd: task.cwd,
    effort: task.effort,
    sandboxPolicy: task.sandboxPolicy,
  });
}

export async function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
  options: RunTasksOptions = {},
): Promise<RunResult[]> {
  if (tasks.length === 0) return [];

  // Resolve + execute each task
  const promises = tasks.map(async (task): Promise<RunResult> => {
    try {
      // Select provider (validates eligibility or auto-routes)
      const providerConfig = selectProviderForTask(task, config);

      // Get or create the provider instance
      const provider = options.providers?.[task.provider ?? providerConfig.type]
        ?? createProvider(task.provider ?? Object.keys(config.providers).find((k) => config.providers[k] === providerConfig)!, config);

      return await executeTask(task, provider);
    } catch (err) {
      return {
        output: `runTasks error: ${err instanceof Error ? err.message : String(err)}`,
        status: 'error',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: null },
        turns: 0,
        files: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  return Promise.all(promises);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/core/run-tasks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/run-tasks.ts tests/core/run-tasks.test.ts
git commit -m "feat(core): add runTasks orchestration"
```

---

## Phase 6: Runners Update

### Task 12: Update runners for new types

**Files:**
- Modify: `packages/core/src/runners/openai-runner.ts`
- Modify: `packages/core/src/runners/claude-runner.ts`
- Modify: `packages/core/src/runners/codex-runner.ts`
- Modify: `packages/core/src/tools/definitions.ts` (type updates only)

The runner implementations are unchanged — only import types change from `../types.js` to `./types.js` and type references update to use new discriminated `ProviderConfig` types.

- [ ] **Step 1: Update type imports in each runner**

In each runner file, change:
```typescript
import type { ..., ProviderConfig, RunOptions } from '../types.js';
```
to:
```typescript
import type { ..., ProviderConfig, RunOptions } from '../types.js';
// ProviderConfig is now a discriminated union — switch statements over .type remain valid
```

Verify the switch/case on `providerConfig.type` still compiles correctly (discriminated union narrows correctly in switch).

- [ ] **Step 2: Verify all runners compile**

Run: `cd packages/core && npx tsc --noEmit`
Expected: no errors (runners should compile as-is with type-only changes)

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runners/ packages/core/src/tools/definitions.ts
git commit -m "refactor(core): update runner imports for discriminated ProviderConfig"
```

---

## Phase 7: MCP Package

### Task 13: Create `packages/mcp/src/cli.ts`

**Files:**
- Create: `packages/mcp/src/cli.ts`
- Test: `tests/mcp/cli.test.ts` (new file)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMcpServer, buildTaskSchema } from '../../packages/mcp/src/cli.js';

describe('buildMcpServer', () => {
  it('creates an MCP server with delegate_tasks tool', () => {
    // Server creation test — just verify it doesn't throw
    const config = {
      providers: {
        codex: { type: 'codex', model: 'gpt-5-codex' },
      },
      defaults: { maxTurns: 200, timeoutMs: 600000, tools: 'full' as const },
    };
    // buildMcpServer is synchronous; just verify no throw
    expect(() => buildMcpServer(config)).not.toThrow();
  });

  it('buildTaskSchema returns a Zod schema', () => {
    const schema = buildTaskSchema(['codex', 'claude']);
    expect(typeof schema.parse).toBe('function');
    // Valid input should parse without throw
    const valid = [
      {
        prompt: 'do the thing',
        provider: 'codex',
        tier: 'standard',
        requiredCapabilities: [],
      },
    ];
    expect(() => schema.parse(valid)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp/cli.test.ts`
Expected: FAIL — file does not exist

- [ ] **Step 3: Write `packages/mcp/src/cli.ts`**

```typescript
import { fileURLToPath } from 'url';
import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfigFromFile } from '@scope/multi-model-agent-core/config/load.js';
import { runTasks } from '@scope/multi-model-agent-core/run-tasks.js';
import { parseConfig } from '@scope/multi-model-agent-core/config/schema.js';
import { renderProviderRoutingMatrix } from './routing/render-provider-routing-matrix.js';
import type { TaskSpec, MultiModelConfig } from '@scope/multi-model-agent-core/types.js';

export const SERVER_NAME = 'multi-model-agent';
export const SERVER_VERSION = '0.1.0';

export function buildTaskSchema(availableProviders: [string, ...string[]]) {
  return z.object({
    tasks: z.array(
      z.object({
        prompt: z.string().describe('Task prompt for the sub-agent'),
        provider: z.enum(availableProviders).optional().describe('Provider name. If omitted, core auto-selects.'),
        tier: z.enum(['trivial', 'standard', 'reasoning']).describe('Required quality tier.'),
        requiredCapabilities: z
          .array(z.enum(['file_read', 'file_write', 'grep', 'glob', 'shell', 'web_search', 'web_fetch']))
          .describe('Capabilities this task requires. Empty array if none.'),
        tools: z.enum(['none', 'full']).optional().describe('Tool access mode. Default: full'),
        maxTurns: z.number().int().positive().optional().describe('Max agent loop turns. Default: 200'),
        timeoutMs: z.number().int().positive().optional().describe('Timeout in ms. Default: 600000'),
        cwd: z.string().optional().describe('Working directory for file/shell tools'),
        effort: z.enum(['none', 'low', 'medium', 'high']).optional().describe('Reasoning effort'),
        sandboxPolicy: z.enum(['none', 'cwd-only']).optional().describe('File-system confinement. Default: cwd-only'),
      }),
    ).describe('Array of tasks to execute in parallel'),
  });
}

export function buildMcpServer(config: MultiModelConfig) {
  const providerKeys = Object.keys(config.providers) as [string, ...string[]];
  if (providerKeys.length === 0) {
    throw new Error('buildMcpServer requires at least one configured provider.');
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    'delegate_tasks',
    renderProviderRoutingMatrix(config),
    { tasks: buildTaskSchema(providerKeys) },
    async ({ tasks }) => {
      const taskSpecs: TaskSpec[] = tasks.map((t) => ({
        prompt: t.prompt,
        provider: t.provider,
        tier: t.tier,
        requiredCapabilities: t.requiredCapabilities,
        tools: t.tools,
        maxTurns: t.maxTurns,
        timeoutMs: t.timeoutMs,
        cwd: t.cwd,
        effort: t.effort,
        sandboxPolicy: t.sandboxPolicy,
      }));

      const results = await runTasks(taskSpecs, config);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                results: results.map((r, i) => ({
                  provider: tasks[i]?.provider ?? '(auto)',
                  status: r.status,
                  output: r.output,
                  turns: r.turns,
                  files: r.files,
                  usage: r.usage,
                  ...(r.error && { error: r.error }),
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== 'serve') {
    console.error('Usage: multi-model-agent serve [--config <path>]');
    process.exit(1);
  }

  const configFlagIdx = args.indexOf('--config');
  const configPath = configFlagIdx >= 0 ? args[configFlagIdx + 1] : undefined;

  // Home-directory config discovery lives ONLY in MCP CLI
  let config: MultiModelConfig;
  if (configPath) {
    config = await loadConfigFromFile(configPath);
  } else {
    const homeConfigPath = `${process.env.HOME ?? '/'}/.multi-model/config.json`;
    try {
      config = await loadConfigFromFile(homeConfigPath);
    } catch {
      console.error('No config file found. Create ~/.multi-model/config.json or pass --config <path>.');
      process.exit(1);
    }
  }

  const server = buildMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

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

- [ ] **Step 3 (sic): Run test to verify it passes**

Run: `npm test -- tests/mcp/cli.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/cli.ts tests/mcp/cli.test.ts
git commit -m "feat(mcp): add buildMcpServer and CLI with home-dir config discovery"
```

---

### Task 14: Create `packages/mcp/src/routing/render-provider-routing-matrix.ts`

**Files:**
- Create: `packages/mcp/src/routing/render-provider-routing-matrix.ts`
- Test: update `tests/routing/describe.test.ts` → rename to `tests/mcp/routing/render-provider-routing-matrix.test.ts`

- [ ] **Step 1: Read `tests/routing/describe.test.ts` and convert it**

Rename `describeProviders` → `renderProviderRoutingMatrix` in all test names and call sites. Move the test file to `tests/mcp/routing/`.

- [ ] **Step 2: Write `packages/mcp/src/routing/render-provider-routing-matrix.ts`**

This is the current `src/routing/describe.ts` content with the function renamed and `describeProviders` → `renderProviderRoutingMatrix`.

```typescript
import type { Capability, MultiModelConfig, ProviderConfig } from '@scope/multi-model-agent-core/types.js';
import { getBaseCapabilities } from '@scope/multi-model-agent-core/routing/capabilities.js';
import { findModelProfile, getEffectiveCostTier } from '@scope/multi-model-agent-core/routing/model-profiles.js';

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
  profile: ReturnType<typeof findModelProfile>,
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
  if (profile.notes) lines.push(`  note: ${profile.notes}`);
  if (profile.avoidFor) lines.push(`  avoid for: ${profile.avoidFor}`);
  return lines.join('\n');
}

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

- [ ] **Step 3: Verify it compiles**

Run: `cd packages/mcp && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/routing/render-provider-routing-matrix.ts
git commit -m "feat(mcp): add renderProviderRoutingMatrix (moved from core)"
```

---

## Phase 8: Cleanup

### Task 15: Delete old files

**Files deleted:**
- `src/delegate.ts`
- `src/config.ts`
- `src/routing/describe.ts`

After all new files are created and committed, delete the old files and add a final commit.

- [ ] **Step 1: Verify no remaining imports reference deleted files**

Run: `grep -r "from.*delegate" packages/core/src/ packages/mcp/src/ 2>/dev/null || echo "clean"`
Run: `grep -r "from.*config.js" packages/core/src/ 2>/dev/null || echo "clean"`
Run: `grep -r "describeProviders" packages/core/src/ packages/mcp/src/ 2>/dev/null || echo "clean"`

Expected: "clean" for all.

- [ ] **Step 2: Delete old files**

```bash
rm src/delegate.ts src/config.ts src/routing/describe.ts
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add -u && git commit -m "refactor: delete old delegate.ts, config.ts, routing/describe.ts"
```

---

## Self-Review Checklist

**Spec coverage:**
- [ ] `runTasks()` — Task 11
- [ ] `createProvider()` — Task 10
- [ ] `parseConfig()` + `loadConfigFromFile()` — Tasks 3, 4
- [ ] `getBaseCapabilities` — Task 5
- [ ] `resolveTaskCapabilities` — Task 7
- [ ] `getProviderEligibility` — Task 8
- [ ] `selectProviderForTask` — Task 9
- [ ] `findModelProfile`, `getEffectiveCostTier` — Task 6
- [ ] Discriminated `ProviderConfig` — Task 2
- [ ] `TaskSpec` — Task 2
- [ ] `ProviderEligibility` — Task 2
- [ ] `renderProviderRoutingMatrix` — Task 14
- [ ] `buildMcpServer` — Task 13
- [ ] `buildTaskSchema` — Task 13
- [ ] Home-dir discovery in MCP only — Task 13
- [ ] Provider config discriminated union with `baseUrl` required on `openai-compatible` — Task 2
- [ ] No `loadConfig` alias — Task 4
- [ ] Core package exports map covers all subpath imports used in MCP — Phase 1

**Placeholder scan:**
- [ ] No "TBD", "TODO", "implement later" anywhere
- [ ] All test code is complete (not "write tests for the above")
- [ ] All functions have complete implementations
- [ ] No "similar to Task N" without code

**Type consistency:**
- [ ] `resolveTaskCapabilities(config, options)` — options is `Pick<RunOptions, 'tools' | 'sandboxPolicy'>`
- [ ] `selectProviderForTask(task, config)` — `task: TaskSpec`, `config: MultiModelConfig`
- [ ] `getProviderEligibility(task, config)` — `task: TaskSpec`, `config: MultiModelConfig`, returns `ProviderEligibility[]`
- [ ] `findModelProfile(modelId)` — returns `ModelProfile`
- [ ] `getEffectiveCostTier(config)` — returns `CostTier`
- [ ] `ProviderEligibilityReport` renamed to `ProviderEligibility` — verified in types.ts
