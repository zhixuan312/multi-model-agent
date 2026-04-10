# Multi-Model Agent: Core + MCP Split Design

**Date:** 2026-04-10
**Status:** Approved

---

## Goal

Split the current `multi-model-agent` into two public npm packages in a monorepo:

- **`@scope/multi-model-agent-core`** — sub-agent orchestration engine
- **`@scope/multi-model-agent-mcp`** — MCP transport adapter (depends on core)

Core owns all policy, routing, validation, and execution. MCP is thin glue that translates MCP input into core calls. All future enhancements to logic, tightening of rules, and behavioral changes happen in core, not MCP.

---

## Architecture

```
packages/
  core/           → @scope/multi-model-agent-core
  mcp/            → @scope/multi-model-agent-mcp (depends on core)
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

Home-directory config discovery lives in `mcp/cli.ts`, not in core. The precedence is:
1. `--config <path>` argument (explicit)
2. `MULTI_MODEL_CONFIG` environment variable
3. `~/.multi-model/config.json` (default home-directory location)

### Routing Metadata Helpers

```typescript
// Returns the static base capabilities for a provider type (before per-task overrides).
// Use resolveTaskCapabilities() for actual runtime capability set.
function getBaseCapabilities(config: ProviderConfig): Capability[]

// Returns the capabilities a task will have at runtime, accounting for
// tools, sandboxPolicy, and hosted tools overrides.
function resolveTaskCapabilities(
  providerConfig: ProviderConfig,
  options: Pick<RunOptions, 'tools' | 'sandboxPolicy'>,
): Capability[]

// Returns routing metadata for a model.
function findModelProfile(modelId: string): ModelProfile

// Returns effective cost tier (config override or profile default).
function getEffectiveCostTier(config: ProviderConfig): CostTier

// Returns structured eligibility report for every configured provider.
// Each entry states whether the provider is eligible and, if not, which
// specific checks failed and why. Use this to debug routing decisions.
function getProviderEligibility(
  task: TaskSpec,
  config: MultiModelConfig,
): ProviderEligibility[]

interface ProviderEligibility {
  name: string
  config: ProviderConfig
  eligible: boolean
  /** Reasons only present when eligible === false. */
  reasons: EligibilityFailure[]
}

/** Extensible — add new check types without a breaking change. */
type EligibilityFailureCheck =
  | 'capability'
  | 'tier'
  | 'tool_mode'
  | 'provider_not_found'
  | 'unsupported_provider_type'
  | 'missing_required_field'
  | string

interface EligibilityFailure {
  check: EligibilityFailureCheck
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
// Internal: select which provider to use for a task (advanced public API)
// Returns both the provider name and config so callers (including runTasks)
// can correctly resolve the selected provider.
function selectProviderForTask(task: TaskSpec, config: MultiModelConfig): { name: string; config: ProviderConfig }

// Internal: run a single task against a resolved provider
async function executeTask(
  task: TaskSpec,
  provider: Provider,
  config: MultiModelConfig,
): Promise<RunResult>

// Public runTasks() orchestrates:
//  1. getProviderEligibility() for each spec — to surface errors before spending tokens
//  2. selectProviderForTask() for each task — returns { name, config }
//  3. createProvider(providerName, config) for each task
//  4. executeTask() in parallel
//  4. return results in input order
```

### Auto-Routing Algorithm (when `provider` is omitted)

When a task does not specify a provider, core selects one using:

1. **Capability filter (HARD):** Exclude any provider missing any `requiredCapability`.
2. **Tier filter (HARD):** Exclude any provider whose `findModelProfile(model).tier` is below `task.tier`. Tier ordering: `trivial < standard < reasoning`.
3. **Cost preference (STRONG):** Among remaining eligible providers, select the cheapest `costTier`.
4. **Tiebreaker:** If multiple providers share the same cost tier, select by provider name sorted ascending (ASCII/lexicographic order).

If no provider passes the filter, the task returns an error `RunResult`. Callers should call `getProviderEligibility(task, config)` to diagnose which checks failed for each configured provider.

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

### Routing Matrix Rendering

`renderProviderRoutingMatrix()` lives in `mcp/src/routing/render-provider-routing-matrix.ts`. It renders the routing matrix for the MCP tool description, helping the consuming LLM understand provider capabilities and routing rules. Core has no knowledge of this rendering.

---

## Package Layout

```
packages/
  core/
    src/
      types.ts                    # TaskSpec, RunResult, Provider, config types
      provider.ts                 # createProvider factory
      run-tasks.ts                # runTasks(), executeTask()
      config/
        schema.ts                 # Zod schema + parseConfig()
        load.ts                   # loadConfigFromFile()
      routing/
        capabilities.ts           # getBaseCapabilities
        model-profiles.ts         # findModelProfile, getEffectiveCostTier, ModelProfile
        resolve-task-capabilities.ts  # resolveTaskCapabilities
        select-provider-for-task.ts    # selectProviderForTask (advanced public API)
        get-provider-eligibility.ts   # getProviderEligibility
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
      cli.ts                      # buildMcpServer + CLI main() + TaskSpecSchema
      routing/
        render-provider-routing-matrix.ts  # renderProviderRoutingMatrix
    package.json
    tsconfig.json

  package.json                    # workspace root (private, not published)
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

## Implementation Notes

- All imports use `.js` extensions (ESM).
- `runTasks()` in `core/src/run-tasks.ts` is the new top-level orchestration file.
- `delegate.ts` is removed — replaced by `run-tasks.ts` with full policy enforcement.
- `describe.ts` is deleted from `core/src/routing/` and replaced by `mcp/src/routing/render-provider-routing-matrix.ts`.
- Routing helpers split into three focused files under `core/src/routing/`: `capabilities.ts` (`getBaseCapabilities`), `model-profiles.ts` (`findModelProfile`, `getEffectiveCostTier`), `resolve-task-capabilities.ts` (`resolveTaskCapabilities`), `select-provider-for-task.ts` (`selectProviderForTask`), `get-provider-eligibility.ts` (`getProviderEligibility`).
- Config split: `schema.ts` (Zod + `parseConfig`), `load.ts` (`loadConfigFromFile`). No `loadConfig` alias.
- `ProviderConfig` is a discriminated union — `CodexProviderConfig`, `ClaudeProviderConfig`, `OpenAICompatibleProviderConfig`. `baseUrl` is required on `OpenAICompatibleProviderConfig`.
