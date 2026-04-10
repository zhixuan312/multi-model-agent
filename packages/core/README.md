# @zhixuan92/multi-model-agent-core

Runtime library for [`multi-model-agent`](https://github.com/zhixuan312/multi-model-agent): provider runners (Claude, Codex, OpenAI-compatible), routing logic (capability / quality tier / cost), config schema, and a sandboxed file/shell tool layer.

This is the building-block library. If you just want to run the MCP server, install [`@zhixuan92/multi-model-agent-mcp`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent-mcp) instead.

## Install

```bash
npm install @zhixuan92/multi-model-agent-core
```

If you plan to use `openai-compatible` providers, also install the optional peer dependencies:

```bash
npm install @openai/agents openai
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

## Documentation

Full docs, configuration reference, supported providers, and the routing matrix live in the project README:

→ **<https://github.com/zhixuan312/multi-model-agent#readme>**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
