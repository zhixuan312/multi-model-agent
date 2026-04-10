# Monorepo Restructuring Design

**Date:** 2026-04-10
**Status:** Approved (with fixes)

## Overview

Restructure the repo from a single-package layout into a workspace monorepo with two packages:

- `@scope/multi-model-agent-core` — the execution engine
- `@scope/multi-model-agent-mcp` — the MCP transport adapter

**Architecture rule:** If a TypeScript backend cannot perform a full agent run by depending only on `@scope/multi-model-agent-core`, the split is wrong.

## Target Structure

```
/repo-root
├── package.json              # Root workspace manifest (private, workspaces only)
├── tsconfig.base.json        # Shared tsconfig
├── vitest.config.ts         # Root vitest config
├── packages/
│   ├── core/                 # @scope/multi-model-agent-core
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts
│   │       ├── config/
│   │       │   ├── schema.ts
│   │       │   └── load.ts
│   │       ├── provider.ts
│   │       ├── run-tasks.ts
│   │       ├── routing/
│   │       │   ├── capabilities.ts
│   │       │   ├── model-profiles.ts
│   │       │   ├── resolve-task-capabilities.ts
│   │       │   ├── select-provider-for-task.ts
│   │       │   └── get-provider-eligibility.ts
│   │       ├── runners/
│   │       │   ├── openai-runner.ts
│   │       │   ├── claude-runner.ts
│   │       │   └── codex-runner.ts
│   │       ├── tools/
│   │       │   ├── definitions.ts
│   │       │   ├── openai-adapter.ts
│   │       │   ├── claude-adapter.ts
│   │       │   └── tracker.ts
│   │       └── auth/
│   │           ├── codex-oauth.ts
│   │           └── claude-oauth.ts
│   └── mcp/                  # @scope/multi-model-agent-mcp
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts       # exports buildMcpServer, buildTaskSchema
│           ├── cli.ts
│           └── routing/
│               └── render-provider-routing-matrix.ts
└── tests/                    # Repo-level tests
```

## File Migration Table

| Root `src/` | Destination |
|---|---|
| `src/types.ts` | `packages/core/src/types.ts` |
| `src/config.ts` | `packages/core/src/config/schema.ts` + `packages/core/src/config/load.ts` |
| `src/provider.ts` | `packages/core/src/provider.ts` |
| `src/delegate.ts` | `packages/core/src/run-tasks.ts` |
| `src/cli.ts` | `packages/mcp/src/cli.ts` |
| `src/runners/*` | `packages/core/src/runners/*` (internal, not exported) |
| `src/tools/*` | `packages/core/src/tools/*` (internal, not exported) |
| `src/auth/*` | `packages/core/src/auth/*` (internal, not exported) |
| `src/routing/*` | `packages/core/src/routing/*` |
| `src/routing/describe.ts` | `packages/mcp/src/routing/render-provider-routing-matrix.ts` (renamed) |

## Package Manifests

### Root `package.json`

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

- No `bin`, no `exports`, no `dependencies`
- All packages managed via workspace

### `packages/core/package.json`

- Name: `@scope/multi-model-agent-core`
- Root `index.ts` re-exports public API: `types`, `config/schema`, `config/load`, `routing/*`, `provider`, `run-tasks`
- Public exports map: `.` (root), `./config/schema`, `./config/load`, `./routing/*`, `./provider`, `./run-tasks`
- Runners, tools, and auth helpers: **not exported** — internal implementation detail
- No `@modelcontextprotocol/sdk` dependency

### `packages/mcp/package.json`

- Name: `@scope/multi-model-agent-mcp`
- `bin: { "multi-model-agent": "./dist/cli.js" }`
- Root `index.ts` exports `buildMcpServer` and `buildTaskSchema`
- Public exports: `.` (root with buildMcpServer, buildTaskSchema), `./routing/render-provider-routing-matrix`
- Depends on `@scope/multi-model-agent-core`
- Depends on `@modelcontextprotocol/sdk`

## Key Contracts

### MULTI_MODEL_CONFIG

Parsed as a **file path** (not inline JSON). Load the file and parse as config. This matches the approved design.

### Build

- Each package builds with `tsc` to its own `dist/`
- Root `npm run build` → `npm run build --workspaces`
- Generated JS files must never be checked in alongside TypeScript source

### Testing

- Tests live in repo-root `tests/`
- Cross-package/public API tests use package imports (`@scope/multi-model-agent-core/*`)
- Internal unit tests may import source files directly (e.g. `../../packages/core/src/types`)
- Root `npm test` runs vitest across all packages

## Root Cleanup

The following must be updated or removed as part of migration:

- `src/` — deleted (moved to `packages/core/src/`)
- `dist/` — deleted (each package has its own `dist/`)
- `package.json` — replaced with workspace-only manifest
- `tsconfig.json` — **deleted** (per-package tsconfigs each reference `tsconfig.base.json` instead)
- `vitest.config.ts` — updated to reference per-package tsconfigs or removed if moved to packages

## Migration Rules

1. **Move first, then refactor** — do not keep a re-export bridge from old `src/`
2. Generated JavaScript files in `src/` must be removed (TypeScript source only)
3. All package entrypoints export public API only; internal modules are not subpath-exported

## Implementation Steps

1. Create `packages/core/` and `packages/mcp/` directory structure
2. Create `packages/core/package.json` and `packages/mcp/package.json`
3. Create `tsconfig.base.json` shared config
4. Move `src/*` → `packages/core/src/`
5. Restructure files per migration table
6. Rename `routing/describe.ts` → `routing/render-provider-routing-matrix.ts` in `packages/mcp/src/`
7. Split `config.ts` → `config/schema.ts` + `config/load.ts`
8. Rename `delegate.ts` → `run-tasks.ts`
9. Update `packages/core/package.json` exports (public API only)
10. Add `bin` entry to `packages/mcp/package.json`
11. Replace root `package.json` with workspace manifest
12. Delete root `src/`, `dist/`
13. Delete root `tsconfig.json` (per-package tsconfigs reference `tsconfig.base.json`)
14. Fix `MULTI_MODEL_CONFIG` parsing (file path, not inline JSON)
15. Update `vitest.config.ts` for workspace structure
16. Update tests to use package imports where appropriate
17. Build and verify all tests pass
