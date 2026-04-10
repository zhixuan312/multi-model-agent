# Multi-Model Agent: Core + MCP Split Design

**Date:** 2026-04-10
**Status:** Draft

---

## Goal

Split the current `multi-model-agent` into two public npm packages in a monorepo:

- **`@scope/multi-model-core`** — sub-agent orchestration engine
- **`@scope/multi-model-mcp`** — MCP transport adapter (depends on core)

Core owns all policy, routing, validation, and execution. MCP is thin glue that translates MCP input into core calls. All future enhancements to logic, tightening of rules, and behavioral changes happen in core, not MCP.

---

## Architecture

```
packages/
  core/           → @scope/multi-model-core
  mcp/            → @scope/multi-model-mcp (depends on core)
```

**Dependency direction:** `mcp → core`. Core has zero knowledge of MCP.

---

## Core Public API

### Primary Entry Point: `runTasks()`

The high-level, policy-enforcing API. All backends and the MCP adapter call this.

```typescript
function runTasks(
  tasks: TaskSpec[],
  config: MultiModelConfig,
): Promise<RunResult[]>
```

**Behavior:**
- Input order is preserved in output order.
- One task failing does not fail the entire batch — all tasks execute; results are independent.
- Each `RunResult` corresponds to the matching `TaskSpec` at the same index.
- Tasks run concurrently (parallelization handled internally).

**When `task.provider` is specified:**
Core validates the named provider satisfies the task's `tier` and `requiredCapabilities` before execution. If validation fails, the task returns an error `RunResult` without spending tokens.

**When `task.provider` is omitted:**
Core applies auto-routing (see Auto-Routing section below) to select the best eligible provider.

### Low-Level Entry Point: `createProvider().run()`

For callers who already know which provider they want and want direct control.

```typescript
function createProvider(name: string, config: MultiModelConfig): Provider
// Provider.run(prompt: string, options?: RunOptions): Promise<RunResult>
```

No policy enforcement. No routing. No capability checks. The caller is responsible for all decisions.

### Config Helpers

```typescript
// Parse a raw config object — validates schema, no side effects
function parseConfig(raw: unknown): MultiModelConfig

// Load and parse a config file by path — opt-in, no auto-lookup
function loadConfigFromFile(path: string): Promise<MultiModelConfig>
```

Home-directory config discovery (`~/.multi-model/config.json`, `MULTI_MODEL_CONFIG`) lives in `mcp/cli.ts`, not in core.

### Routing Metadata Helpers

```typescript
// Returns the capabilities a task will have at runtime, accounting for
// tools, sandboxPolicy, and hosted tools overrides.
function resolveTaskCapabilities(
  providerConfig: ProviderConfig,
  options: Pick<RunOptions, 'tools' | 'sandboxPolicy'>,
): Capability[]

// Returns routing metadata for a model.
function findProfile(modelId: string): ModelProfile

// Returns effective cost tier (config override or profile default).
function effectiveCost(config: ProviderConfig): CostTier

// Returns structured eligibility report for every configured provider.
// Each entry states whether the provider is eligible and, if not, which
// specific checks failed and why. Use this to debug routing decisions.
function getEligibleProviders(
  task: TaskSpec,
  config: MultiModelConfig,
): ProviderEligibilityReport[]

interface ProviderEligibilityReport {
  name: string
  config: ProviderConfig
  eligible: boolean
  /** Reason only present when eligible === false. */
  reasons: EligibilityFailure[]
}

interface EligibilityFailure {
  check: 'capability' | 'tier' | 'tool_mode'
  detail: string
  /** e.g. "shell not available under sandboxPolicy 'cwd-only'" */
  message: string
}
```

### Core Public Types

```typescript
interface TaskSpec {
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

type Tier = 'trivial' | 'standard' | 'reasoning'
type Capability = 'file_read' | 'file_write' | 'grep' | 'glob' | 'shell' | 'web_search' | 'web_fetch'
type ToolMode = 'none' | 'full'
type SandboxPolicy = 'none' | 'cwd-only'
type Effort = 'none' | 'low' | 'medium' | 'high'
type CostTier = 'free' | 'low' | 'medium' | 'high'
type RunStatus = 'ok' | 'error' | 'timeout' | 'max_turns'

interface RunResult {
  output: string
  status: RunStatus
  usage: TokenUsage
  turns: number
  files: string[]
  error?: string
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  costUSD: number | null
}

/** Discriminated union — each provider type has distinct required fields. */
type ProviderConfig =
  | CodexProviderConfig
  | ClaudeProviderConfig
  | OpenAICompatibleProviderConfig

interface CodexProviderConfig {
  type: 'codex'
  model: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
}

interface ClaudeProviderConfig {
  type: 'claude'
  model: string
  effort?: Effort
  maxTurns?: number
  timeoutMs?: number
  sandboxPolicy?: SandboxPolicy
  hostedTools?: ('web_search' | 'image_generation' | 'code_interpreter')[]
  costTier?: CostTier
}

interface OpenAICompatibleProviderConfig {
  type: 'openai-compatible'
  model: string
  /** Required — must be specified. No default. Omitting this is a config error. */
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

interface MultiModelConfig {
  providers: Record<string, ProviderConfig>
  defaults: {
    maxTurns: number
    timeoutMs: number
    tools: ToolMode
  }
}
```

**Why a discriminated union?** `openai-compatible` has no meaningful defaults — callers who omit `baseUrl` silently hit OpenAI public API defaults instead of their intended endpoint. Making `baseUrl` required on the discriminated type forces config to be explicit, closing the misrouting risk.

---

## Core Internal Design

### Internal Split: Resolution vs Execution

Core internally separates provider selection from task execution. This keeps routing logic testable and reusable.

```typescript
// Internal: resolve which provider to use for a task
function resolveTaskProvider(task: TaskSpec, config: MultiModelConfig): ProviderConfig

// Internal: run a single task against a resolved provider
async function executeTask(
  task: TaskSpec,
  provider: Provider,
  config: MultiModelConfig,
): Promise<RunResult>

// Public runTasks() orchestrates:
//  1. getEligibleProviders() for each spec — to surface errors before spending tokens
//  2. resolveTaskProvider() for each task
//  3. executeTask() in parallel
//  4. return results in input order
```

### Auto-Routing Algorithm (when `provider` is omitted)

When a task does not specify a provider, core selects one using:

1. **Capability filter (HARD):** Exclude any provider missing any `requiredCapability`.
2. **Tier filter (HARD):** Exclude any provider whose `findProfile(model).tier` is below `task.tier`. Tier ordering: `trivial < standard < reasoning`.
3. **Cost preference (STRONG):** Among remaining eligible providers, select the cheapest `costTier`.
4. **Tiebreaker:** If multiple providers share the same cost tier, select by provider name sorted ascending (ASCII/lexicographic order).

If no provider passes the filter, the task returns an error `RunResult`. Callers should call `getEligibleProviders(task, config)` to diagnose which checks failed for each configured provider.

### `resolveTaskCapabilities()` Behavior

This function must be accurate for the capability enforcement to be trustworthy. It computes the actual runtime capability set by checking:

- `tools: 'none'` → returns `[]` (no capabilities)
- Provider type (codex, claude, openai-compatible)
- `sandboxPolicy` override → `shell` only included when `'none'`
- `hostedTools` config for the provider
- `tools` mode (`'full'` gates all tool capabilities)

The output of this function is what capability enforcement is compared against.

---

## MCP Public API

```typescript
// Build an MCP server from a MultiModelConfig.
// The returned server exposes one tool: delegate_tasks.
// CLI entry: node @scope/multi-model-mcp serve [--config <path>]
function buildMcpServer(config: MultiModelConfig): McpServer

// Optional: programmatic schema builder for the delegate_tasks tool input
function buildTaskSchema(availableProviders: [string, ...string[]]): z.ZodSchema
```

**MCP responsibilities (and only MCP responsibilities):**
- Define the MCP tool schema (Zod shapes for the `delegate_tasks` tool)
- Parse MCP tool input into `TaskSpec[]`
- Call `runTasks(tasks, config)` from core
- Format `RunResult[]` into MCP response JSON
- Home-directory config discovery in CLI entry point only

**MCP does NOT:**
- Enforce tier compatibility
- Check `requiredCapabilities`
- Apply routing/selection logic
- Modify execution behavior

### `describeProviders()` Location

`describeProviders()` lives in `mcp/src/routing/describe.ts`. It renders the routing matrix for the MCP tool description, helping the consuming LLM understand provider capabilities and routing rules. Core has no knowledge of this rendering.

---

## Package Layout

```
packages/
  core/
    src/
      types.ts                    # TaskSpec, RunResult, Provider, config types
      provider.ts                 # createProvider factory
      run-tasks.ts                # runTasks(), executeTask(), resolveTaskProvider()
      config/
        schema.ts                 # Zod schema + parseConfig()
        load.ts                   # loadConfigFromFile()
      routing/
        capabilities.ts           # getCapabilities
        model-profiles.ts          # findProfile, effectiveCost, ModelProfile
        resolve.ts                 # resolveTaskProvider, getEligibleProviders,
                                    # resolveTaskCapabilities
      runners/
        openai-runner.ts
        claude-runner.ts
        codex-runner.ts
      tools/
        definitions.ts            # createToolImplementations, ToolImplementations
        tracker.ts                # FileTracker
        openai-adapter.ts
        claude-adapter.ts
      auth/
        codex-oauth.ts
        claude-oauth.ts
    package.json
    tsconfig.json

  mcp/
    src/
      cli.ts                      # buildMcpServer + CLI main()
      routing/
        describe.ts               # describeProviders
    package.json
    tsconfig.json

  package.json                    # workspace root
  tsconfig.base.json              # shared base tsconfig
```

---

## Batch Failure Semantics

- **Independent execution:** Each task executes independently. One failure does not affect others.
- **Result alignment:** `results[i]` corresponds to `tasks[i]`, always.
- **Partial success:** A batch where some tasks succeed and others fail returns a `RunResult` array where some items have `status: 'error'` and others have `status: 'ok'`.
- **No early termination:** All tasks run to completion or timeout/error. Core does not halt on first failure.

---

## Provider Selection Determinism

Auto-routing is fully deterministic. The sort key at each step is explicit and reproducible:

- **Step 1–2** (capability + tier): produce an unordered eligible set by exclusion.
- **Step 3** (cost): sort eligible providers ascending by `costTier` (`free < low < medium < high`).
- **Step 4** (tiebreaker): among providers tied at the same cost tier, select by provider name ascending (ASCII/lexicographic).

No randomness or non-deterministic tie-breaking. A caller who wants a different selection strategy can specify `provider` explicitly.

---

## Backward Compatibility Notes

This is a v0.1.0 greenfield project. No backward compatibility is required. The following are breaking changes by design:

- `DelegateTask` from current `src/types.ts` is replaced by `TaskSpec`.
- `delegateAll()` is replaced by `runTasks()` as the primary entry point.
- `getEffectiveCapabilities` is renamed to `resolveTaskCapabilities` and its signature is updated to take `RunOptions` (not just `ProviderConfig`).
- Home-directory config auto-discovery is removed from core and moves to `mcp/cli.ts`.
- `tier` and `requiredCapabilities` become first-class core concepts (enforced by core, not just stored).

---

## Implementation Notes

- All imports use `.js` extensions (ESM).
- `runTasks()` in `core/src/run-tasks.ts` is the new top-level orchestration file.
- `delegate.ts` is removed — replaced by `run-tasks.ts` with full policy enforcement.
- `describe.ts` moves from `core/src/routing/` to `mcp/src/routing/`.
- `getEffectiveCapabilities` in `delegate.ts` becomes `resolveTaskCapabilities` in `core/src/routing/resolve.ts`.
- `delegate.ts` is removed — replaced by `run-tasks.ts`.
- Routing helpers reorganized: `capabilities.ts`, `model-profiles.ts`, `resolve.ts` under `core/src/routing/`.
- Config split: `schema.ts` (Zod + parse), `load.ts` (file loading helper).
- `ProviderConfig` becomes a discriminated union — `CodexProviderConfig`, `ClaudeProviderConfig`, `OpenAICompatibleProviderConfig`. `baseUrl` is required on `OpenAICompatibleProviderConfig`.
- `getEligibleProviders()` returns `ProviderEligibilityReport[]` for all providers (not just eligible), with per-check failure reasons.
