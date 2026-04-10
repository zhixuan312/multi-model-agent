# Monorepo Restructuring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the repo into a workspace monorepo with `@scope/multi-model-agent-core` (execution engine) and `@scope/multi-model-agent-mcp` (MCP transport adapter). Root becomes workspace-only.

**Architecture:** Copy current `src/` into `packages/core/src/`, restructure in place, then carve out MCP adapter. No re-export bridge. Move first, then refactor.

**Tech Stack:** TypeScript, Node >=22, npm workspaces, Vitest, Zod

---

## Phase 1: Scaffold

### Task 1: Create directory structure

**Files:**
- Create: `packages/core/src/`
- Create: `packages/mcp/src/routing/`
- Create: `packages/core/tsconfig.json`
- Create: `packages/mcp/tsconfig.json`

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

### Task 3: Create packages/core/package.json

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

### Task 4: Create packages/core/tsconfig.json

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

### Task 5: Create packages/mcp/package.json

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

### Task 6: Create packages/mcp/tsconfig.json

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

## Phase 2: Copy and restructure source

### Task 7: Copy types.ts and provider.ts

**Files:**
- Copy: `src/types.ts` → `packages/core/src/types.ts`
- Copy: `src/provider.ts` → `packages/core/src/provider.ts`

- [ ] **Step 1: Copy files**

```bash
cp src/types.ts packages/core/src/types.ts
cp src/provider.ts packages/core/src/provider.ts
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/provider.ts
git commit -m "chore: copy types.ts and provider.ts to core"
```

---

### Task 8: Split config.ts into config/schema.ts and config/load.ts

**Files:**
- Copy: `src/config.ts` → `packages/core/src/config/schema.ts` (zod schemas only, no loadConfig)
- Create: `packages/core/src/config/load.ts` (loadConfig function, imports schema from sibling)

The current `src/config.ts` contains:
- Lines 7-43: `providerConfigSchema` and `configSchema` (Zod schemas) → `config/schema.ts`
- Lines 49-79: `loadConfig()` function → `config/load.ts` (imports schemas from `./schema.js`)

**config/schema.ts** content:
```typescript
import { z } from 'zod';

export const providerConfigSchema: z.ZodType<{
  type: 'codex' | 'claude' | 'openai-compatible';
  model: string;
  effort?: 'none' | 'low' | 'medium' | 'high';
  maxTurns?: number;
  timeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  sandboxPolicy?: 'none' | 'cwd-only';
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[];
  costTier?: 'free' | 'low' | 'medium' | 'high';
}> = z.object({
  type: z.enum(['codex', 'claude', 'openai-compatible']),
  model: z.string(),
  effort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  sandboxPolicy: z.enum(['none', 'cwd-only']).optional(),
  hostedTools: z.array(z.enum(['web_search', 'image_generation', 'code_interpreter'])).optional(),
  costTier: z.enum(['free', 'low', 'medium', 'high']).optional(),
}).refine(
  (data) => data.type !== 'openai-compatible' || (data.baseUrl != null && data.baseUrl.length > 0),
  { message: 'Provider type "openai-compatible" requires a baseUrl field.' }
);

export const configSchema = z.object({
  providers: z.record(z.string(), providerConfigSchema).default({}),
  defaults: z.object({
    maxTurns: z.number().int().positive().default(200),
    timeoutMs: z.number().int().positive().default(600_000),
    tools: z.enum(['none', 'full']).default('full'),
  }).default(() => ({ maxTurns: 200, timeoutMs: 600_000, tools: 'full' as const })),
});
```

**config/load.ts** content:
```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import { configSchema } from './schema.js';
import type { MultiModelConfig } from '../types.js';

const CONFIG_SEARCH_PATHS = [
  path.join(os.homedir(), '.multi-model', 'config.json'),
];

export function loadConfig(configPath?: string): MultiModelConfig {
  // Explicit path
  if (configPath) {
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return configSchema.parse(raw);
  }

  // Env var — parsed as FILE PATH (not inline JSON) per approved design
  const envPath = process.env.MULTI_MODEL_CONFIG;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`Config file not found (MULTI_MODEL_CONFIG): ${envPath}`);
    }
    const raw = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
    return configSchema.parse(raw);
  }

  // Search paths
  for (const searchPath of CONFIG_SEARCH_PATHS) {
    if (fs.existsSync(searchPath)) {
      const raw = JSON.parse(fs.readFileSync(searchPath, 'utf-8'));
      return configSchema.parse(raw);
    }
  }

  // No config found — return defaults
  return configSchema.parse({});
}
```

- [ ] **Step 1: Create packages/core/src/config/schema.ts**
- [ ] **Step 2: Create packages/core/src/config/load.ts**
- [ ] **Step 3: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/config/load.ts
git commit -m "chore: split config.ts into config/schema.ts and config/load.ts"
```

---

### Task 9: Copy routing files

**Files:**
- Copy: `src/routing/capabilities.ts` → `packages/core/src/routing/capabilities.ts`
- Copy: `src/routing/model-profiles.ts` → `packages/core/src/routing/model-profiles.ts`
- Copy: `src/routing/describe.ts` → `packages/mcp/src/routing/render-provider-routing-matrix.ts` (renamed)

Note: `describe.ts` has `describeProviders` which is MCP-specific (used for MCP tool description). Move it to the mcp package as `render-provider-routing-matrix.ts`.

- [ ] **Step 1: Copy routing files**

```bash
cp src/routing/capabilities.ts packages/core/src/routing/capabilities.ts
cp src/routing/model-profiles.ts packages/core/src/routing/model-profiles.ts
cp src/routing/describe.ts packages/mcp/src/routing/render-provider-routing-matrix.ts
```

- [ ] **Step 2: In packages/mcp/src/routing/render-provider-routing-matrix.ts, update imports:**
Change `from '../types.js'` → `from '@scope/multi-model-agent-core/types'`
Change `from './capabilities.js'` → `from '@scope/multi-model-agent-core/routing/capabilities'`
Change `from './model-profiles.js'` → `from '@scope/multi-model-agent-core/routing/model-profiles'`
Also update the function export name: rename `describeProviders` → `renderProviderRoutingMatrix`

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/routing/capabilities.ts packages/core/src/routing/model-profiles.ts packages/mcp/src/routing/render-provider-routing-matrix.ts
git commit -m "chore: copy routing files — describe->renderProviderRoutingMatrix goes to mcp"
```

---

### Task 10: Copy runners and tools

**Files:**
- Copy: `src/runners/openai-runner.ts` → `packages/core/src/runners/openai-runner.ts`
- Copy: `src/runners/claude-runner.ts` → `packages/core/src/runners/claude-runner.ts`
- Copy: `src/runners/codex-runner.ts` → `packages/core/src/runners/codex-runner.ts`
- Copy: `src/tools/definitions.ts` → `packages/core/src/tools/definitions.ts`
- Copy: `src/tools/openai-adapter.ts` → `packages/core/src/tools/openai-adapter.ts`
- Copy: `src/tools/claude-adapter.ts` → `packages/core/src/tools/claude-adapter.ts`
- Copy: `src/tools/tracker.ts` → `packages/core/src/tools/tracker.ts`
- Copy: `src/auth/codex-oauth.ts` → `packages/core/src/auth/codex-oauth.ts`
- Copy: `src/auth/claude-oauth.ts` → `packages/core/src/auth/claude-oauth.ts`

These are all internal to core (not exported publicly).

- [ ] **Step 1: Copy all runner, tool, and auth files**

```bash
cp src/runners/*.ts packages/core/src/runners/
cp src/tools/*.ts packages/core/src/tools/
cp src/auth/*.ts packages/core/src/auth/
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/runners/ packages/core/src/tools/ packages/core/src/auth/
git commit -m "chore: copy runners, tools, auth to core (internal)"
```

---

### Task 11: Copy delegate.ts as run-tasks.ts

**Files:**
- Copy: `src/delegate.ts` → `packages/core/src/run-tasks.ts` (renamed)

`delegate.ts` exports `delegateAll` and `getEffectiveCapabilities`. Rename the file to `run-tasks.ts` per spec. Update the import in `run-tasks.ts` from `./delegate.js` to no longer exist — the capability check logic stays in `run-tasks.ts` but imports from `./routing/capabilities.js`.

- [ ] **Step 1: Copy and rename**

```bash
cp src/delegate.ts packages/core/src/run-tasks.ts
```

- [ ] **Step 2: In packages/core/src/run-tasks.ts, update imports:**
Change `from './delegate.js'` references (there are none in the file itself — it's already using relative paths like `./types.js` and `./routing/capabilities.js`)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/run-tasks.ts
git commit -m "chore: copy delegate.ts as run-tasks.ts to core"
```

---

### Task 12: Create packages/core/src/index.ts

**Files:**
- Create: `packages/core/src/index.ts`

This re-exports the public API: types, config/load, config/schema, routing, provider, run-tasks.

```typescript
export { loadConfig } from './config/load.js';
export { configSchema, providerConfigSchema } from './config/schema.js';
export type { MultiModelConfig, ProviderConfig, ProviderType, RunResult, RunOptions, RunStatus, SandboxPolicy, ToolMode, TokenUsage, DelegateTask } from './types.js';
export { createProvider } from './provider.js';
export { delegateAll, getEffectiveCapabilities } from './run-tasks.js';
export type { Provider } from './types.js';
```

- [ ] **Step 1: Write packages/core/src/index.ts**

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add public API index.ts"
```

---

### Task 13: Create packages/mcp/src/cli.ts

**Files:**
- Copy: `src/cli.ts` → `packages/mcp/src/cli.ts`

The MCP CLI. Update imports to use `@scope/multi-model-agent-core/*`:

Change `from './config.js'` → `from '@scope/multi-model-agent-core/config/load'`
Change `from './provider.js'` → `from '@scope/multi-model-agent-core'`
Change `from './delegate.js'` → `from '@scope/multi-model-agent-core/run-tasks'`
Change `from './types.js'` → `from '@scope/multi-model-agent-core'`
Change `from './routing/describe.js'` → `from '@scope/multi-model-agent-mcp/routing/render-provider-routing-matrix'`

Also update `describeProviders(config)` call → `renderProviderRoutingMatrix(config)`.

The `buildTaskSchema` and `buildMcpServer` functions stay in `cli.ts` — they are the MCP entrypoint. The `index.ts` will re-export them.

- [ ] **Step 1: Copy src/cli.ts to packages/mcp/src/cli.ts**

- [ ] **Step 2: Update all imports in packages/mcp/src/cli.ts to use @scope/multi-model-agent-core package path**
- [ ] **Step 3: Rename `describeProviders` call to `renderProviderRoutingMatrix`**

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/cli.ts
git commit -m "feat(mcp): move cli.ts with updated package imports"
```

---

### Task 14: Create packages/mcp/src/index.ts

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

## Phase 3: Update root and cleanup

### Task 15: Replace root package.json with workspace manifest

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
  }
}
```

- [ ] **Step 1: Replace package.json content with workspace manifest**
- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "refactor: convert root to workspace-only manifest"
```

---

### Task 16: Delete root src/, dist/, and tsconfig.json

**Files:**
- Delete: `src/` (all contents)
- Delete: `dist/` (all contents)
- Delete: `tsconfig.json`

```bash
rm -rf src/ dist/
rm tsconfig.json
```

- [ ] **Step 1: Delete src/, dist/, tsconfig.json**

```bash
rm -rf src/ dist/ tsconfig.json
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: remove old single-package src, dist, tsconfig.json"
```

Note: `git add -A` stages deletions automatically.

---

### Task 17: Update vitest.config.ts

**Files:**
- Modify: `vitest.config.ts`

The vitest config should work with both packages. Update to use project references or keep it simple with workspace support:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
  },
});
```

Vitest should pick up test files in `tests/` that import from `packages/core/src/` directly (for internal tests) or from package names (for API tests). No major changes needed here since vitest handles TypeScript via tsconfig.

- [ ] **Step 1: Verify vitest.config.ts still works; no changes expected**
- [ ] **Step 2: Commit (or skip if no changes)**

---

### Task 18: Update tests to use package imports

**Files:**
- Modify: `tests/config.test.ts` — change `from '../src/config.js'` → `from '@scope/multi-model-agent-core/config/load'`
- Modify: `tests/provider.test.ts` — change `from '../src/provider.js'` → `from '@scope/multi-model-agent-core'`
- Modify: `tests/delegate.test.ts` — change `from '../src/delegate.js'` → `from '@scope/multi-model-agent-core/run-tasks'`
- Modify: `tests/cli.test.ts` — change imports to `@scope/multi-model-agent-mcp` and `@scope/multi-model-agent-core`
- Modify: `tests/routing/describe.test.ts` — imports from mcp package now
- Modify: `tests/types.test.ts`, `tests/routing/capabilities.test.ts`, `tests/routing/model-profiles.test.ts`, `tests/tools/*.test.ts`, `tests/auth/*.test.ts`, `tests/runners/*.test.ts` — update relative imports to point to new package paths

**Internal rule:** Tests that test internal modules (e.g. `tests/runners/openai-runner.test.ts`) may use relative paths like `../../packages/core/src/runners/openai-runner.ts` or package paths. Tests that test public API should use package names.

- [ ] **Step 1: Update each test file's imports**

For each test file, open it, find the import from `../src/...`, update to the appropriate package path.

- [ ] **Step 2: Commit after all test updates**

```bash
git add tests/
git commit -m "test: update imports to use package paths"
```

---

### Task 19: Build and verify tests pass

**Files:**
- All packages

- [ ] **Step 1: Run npm run build**

Expected: Both packages build without TypeScript errors

```bash
npm run build
```

- [ ] **Step 2: Run npm test**

Expected: All tests pass

```bash
npm test
```

- [ ] **Step 3: If build or tests fail, diagnose and fix inline, then retry**

- [ ] **Step 4: Commit final state if everything passes**

```bash
git add -A
git commit -m "chore: verify build and tests pass after monorepo restructure"
```

---

## Self-Review Checklist

- [ ] All files in spec's migration table are accounted for
- [ ] `packages/core/src/index.ts` re-exports all public API
- [ ] `packages/mcp/src/index.ts` exports `buildMcpServer`, `buildTaskSchema`, `renderProviderRoutingMatrix`
- [ ] `packages/core/package.json` has no runners/tools auth in exports
- [ ] `packages/mcp/package.json` has `bin.multi-model-agent` wired up
- [ ] Root `package.json` is workspace-only, no dependencies
- [ ] Root `src/`, `dist/`, `tsconfig.json` deleted
- [ ] `MULTI_MODEL_CONFIG` parsed as file path (already correct in root src — no change needed)
- [ ] No generated `.js` files checked in alongside `.ts` source
- [ ] All tests pass with `npm test`
