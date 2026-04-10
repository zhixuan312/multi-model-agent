# Core + MCP Revamp: Rename Reference

**Date:** 2026-04-10
**Purpose:** Authoritative rename map for implementation. All old names are deleted — no aliases, no backward compat.

---

## Package / Repo

| Role | New Name |
|------|----------|
| Repo | `multi-model-agent` (unchanged) |
| Workspace root | private, not published |
| Published core | `@scope/multi-model-agent-core` |
| Published MCP | `@scope/multi-model-agent-mcp` |
| Binary | `multi-model-agent` (unchanged) |
| CLI entry | `multi-model-agent serve` (unchanged) |

---

## Core Public API

| Old Name | New Name | Package | File |
|----------|----------|---------|------|
| `delegateAll` | `runTasks` | core | `src/run-tasks.ts` |
| `DelegateTask` | `TaskSpec` | core | `src/types.ts` |
| `getEffectiveCapabilities` | `resolveTaskCapabilities` | core | `src/routing/resolve-task-capabilities.ts` |
| `evaluateProviders` | `getProviderEligibility` | core | `src/routing/get-provider-eligibility.ts` |
| `findProfile` | `findModelProfile` | core | `src/routing/model-profiles.ts` |
| `effectiveCost` | `getEffectiveCostTier` | core | `src/routing/model-profiles.ts` |
| `loadConfig` | `parseConfig` + `loadConfigFromFile` | core | `src/config/schema.ts` + `src/config/load.ts` |
| `getCapabilities` | `getBaseCapabilities` | core | `src/routing/capabilities.ts` |
| `createProvider` | (unchanged) | core | `src/provider.ts` |
| `Provider.run` | (unchanged) | core | `src/provider.ts` |

---

## Core Public Types

| Old Name | New Name | File |
|----------|----------|------|
| `DelegateTask` | `TaskSpec` | `src/types.ts` |
| `ProviderConfig` (flat) | `ProviderConfig` (discriminated union) | `src/types.ts` |
| `ProviderEligibilityReport` | `ProviderEligibility` | `src/types.ts` |
| `EligibilityFailure.check` | `EligibilityFailureCheck` (string union, extensible) | `src/types.ts` |

---

## Core File Changes

| Old File | New File | Change |
|----------|----------|--------|
| `src/delegate.ts` | `src/run-tasks.ts` | Rename + rewrite |
| `src/config.ts` | `src/config/schema.ts` | Split |
| — | `src/config/load.ts` | Split (new) |
| `src/routing/describe.ts` | **DELETED** | Moved to MCP |
| `src/routing/capabilities.ts` | `src/routing/capabilities.ts` | Keep + rename `getCapabilities` → `getBaseCapabilities` |
| `src/routing/model-profiles.ts` | `src/routing/model-profiles.ts` | Keep + rename exports |
| — | `src/routing/resolve-task-capabilities.ts` | New file |
| — | `src/routing/select-provider-for-task.ts` | New file |
| — | `src/routing/get-provider-eligibility.ts` | New file |

---

## MCP Public API

| Old Name | New Name | Package | File |
|----------|----------|---------|------|
| `buildMcpServer` | (unchanged) | mcp | `mcp/src/cli.ts` |
| `buildTaskSchema` | (unchanged) | mcp | `mcp/src/cli.ts` |
| `delegate_tasks` (tool name) | (unchanged) | mcp | `mcp/src/cli.ts` |

---

## MCP File Changes

| Old File | New File | Change |
|----------|----------|--------|
| `src/routing/describe.ts` | `mcp/src/routing/render-provider-routing-matrix.ts` | Move + rename function |
| `mcp/src/cli.ts` | `mcp/src/cli.ts` | Update imports, no rename |
| `DelegateTaskSchema` | `TaskSpecSchema` | mcp/src/cli.ts |

---

## Provider Config — Discriminated Union

```
OLD: ProviderConfig (flat, baseUrl optional on all)
NEW: ProviderConfig (discriminated union)
  ├── CodexProviderConfig         type: 'codex'
  ├── ClaudeProviderConfig        type: 'claude'
  └── OpenAICompatibleProviderConfig  type: 'openai-compatible', baseUrl REQUIRED
```

No `apiKey`/`apiKeyEnv` on `CodexProviderConfig` or `ClaudeProviderConfig` — auth handled internally by those runners.

---

## Deleted Types (not in new design)

- `Provider` — kept (but ProviderConfig changes)
- `RunOptions` — kept
- `RunResult` — kept
- All capability/tier/cost types — kept, some renamed

---

## Deleted Files (not in new design)

- `src/delegate.ts` — replaced by `src/run-tasks.ts`
- `src/config.ts` — replaced by `src/config/schema.ts` + `src/config/load.ts`
- `src/routing/describe.ts` — moved to `mcp/src/routing/render-provider-routing-matrix.ts`

---

## Quick Lookup: Old → New

```
delegateAll                 → runTasks
DelegateTask                → TaskSpec
getEffectiveCapabilities    → resolveTaskCapabilities
evaluateProviders           → getProviderEligibility
findProfile                 → findModelProfile
effectiveCost               → getEffectiveCostTier
loadConfig                  → parseConfig + loadConfigFromFile
getCapabilities             → getBaseCapabilities
ProviderEligibilityReport   → ProviderEligibility
describeProviders           → renderProviderRoutingMatrix
describe.ts                 → render-provider-routing-matrix.ts
delegate.ts                 → run-tasks.ts
config.ts                   → schema.ts + load.ts
```
