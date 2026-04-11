# @zhixuan92/multi-model-agent-core

**Runtime library for [`multi-model-agent`](https://github.com/zhixuan312/multi-model-agent) — import it to run multi-provider agent tasks directly from your own Node program.**

Use this package when you want to embed the same routing and dispatch logic inside your own process instead of going through an MCP client. It ships:

- **Provider runners** — Claude (`@anthropic-ai/claude-agent-sdk`), Codex (OpenAI Responses API with `codex login` or `OPENAI_API_KEY`), and any OpenAI-compatible endpoint.
- **Routing engine** — capability filter → quality tier filter → cheapest qualifying provider, with the full escalation chain walked automatically on failure.
- **`runTasks`** — a single function that takes a task array and a config, runs them in parallel, and returns one result per task (usage, costUSD, savedCostUSD, files touched, status, escalation log).
- **Config schema** — Zod-validated loader for `~/.multi-model/config.json` so callers get the same config contract as the MCP server.
- **Sandboxed tool layer** — `readFile`, `writeFile`, `grep`, `glob`, `listFiles`, `runShell` with `cwd-only` confinement via `fs.realpath`, size caps, and per-call enforcement.

> **If you just want a `delegate_tasks` tool in Claude Code / Claude Desktop / Codex CLI**, install [`@zhixuan92/multi-model-agent-mcp`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent-mcp) instead — it wraps this library in an MCP stdio server. You don't need `-core` directly for that.

## Install

```bash
npm install @zhixuan92/multi-model-agent-core
```

Requires Node `>= 22`. ESM only.

## What's exported

```ts
import {
  // Config
  loadConfigFromFile,
  parseConfig,
  multiModelConfigSchema,

  // Provider factory + dispatch
  createProvider,
  runTasks,

  // Routing helpers
  selectProviderForTask,
  getProviderEligibility,
  getBaseCapabilities,
  resolveTaskCapabilities,
  findModelProfile,
  getEffectiveCostTier,
} from '@zhixuan92/multi-model-agent-core';

import type {
  MultiModelConfig,
  ProviderConfig,
  TaskSpec,
  RunResult,
  RunStatus,
  Tier,
  Capability,
  CostTier,
  Effort,
  SandboxPolicy,
} from '@zhixuan92/multi-model-agent-core';
```

Subpath exports are available for tree-shaking-friendly imports:

| Subpath | What |
| --- | --- |
| `./config/schema` | `parseConfig`, `multiModelConfigSchema` |
| `./config/load` | `loadConfigFromFile` |
| `./routing/capabilities` | base provider capability table |
| `./routing/model-profiles` | tier/cost defaults per model name prefix |
| `./routing/select-provider-for-task` | routing decision |
| `./routing/get-provider-eligibility` | per-provider eligibility breakdown with reasons |
| `./routing/resolve-task-capabilities` | merges per-task overrides into provider capabilities |
| `./provider` | `createProvider` factory |
| `./run-tasks` | `runTasks` parallel dispatcher |
| `./types` | all shared types |

## Quick example

```ts
import { runTasks } from '@zhixuan92/multi-model-agent-core';

const config = {
  providers: {
    claude: { type: 'claude', model: 'claude-sonnet-4-6' },
    codex: { type: 'codex', model: 'gpt-5-codex' },
  },
  defaults: { maxTurns: 200, timeoutMs: 600_000, tools: 'full' },
};

const results = await runTasks(
  [
    { prompt: 'Refactor auth.ts to use JWT.', tier: 'reasoning', requiredCapabilities: ['file_read', 'file_write'] },
    { prompt: 'List all .ts files.', tier: 'trivial', requiredCapabilities: ['glob'] },
  ],
  config,
);

for (const r of results) {
  console.log(r.status, r.output);
}
```

`runTasks` runs each task on the cheapest eligible provider in parallel and returns a result per task. Pin a task to a specific provider by adding `provider: 'claude'`.

## Sandbox

File tools enforce `sandboxPolicy: 'cwd-only'` by default — paths must resolve (via `fs.realpath`) inside the task's `cwd`. `runShell` is hard-disabled under `cwd-only`. `readFile` rejects targets larger than 50 MiB and `writeFile` rejects content larger than 100 MiB before touching memory or disk.

## Updating

Bump via `npm install @zhixuan92/multi-model-agent-core@latest` (or `npm update`). The package is on **0.x semver**: any MINOR bump (`0.2.x → 0.3.0`) may change the config schema, the `runTasks` task shape, or exported types. PATCH bumps (`0.3.0 → 0.3.1`) are strictly backwards-compatible bug fixes.

Always skim [`CHANGELOG.md`](https://github.com/zhixuan312/multi-model-agent/blob/HEAD/CHANGELOG.md) before picking up a new MINOR version — if it calls out a schema change, update your config loader and any stored task specs before upgrading. Subpath exports listed above are part of the public API contract and are versioned together with the main entry point.

If you also depend on `@zhixuan92/multi-model-agent-mcp`, keep the two packages on matching MINOR versions — the MCP server declares a `^0.X.0` range on this library and mismatched versions can surface as type drift or schema validation errors.

## Documentation

Full docs, configuration reference, supported providers, and the routing matrix live in the project README:

→ **<https://github.com/zhixuan312/multi-model-agent#readme>**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
