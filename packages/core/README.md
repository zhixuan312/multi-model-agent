# @zhixuan92/multi-model-agent-core

**Runtime library for multi-model-agent.** Import it to run multi-provider agent tasks directly from your own Node program — same routing, supervision, and review pipeline, without the HTTP server.

> **Want the standalone service instead?** Install [`@zhixuan92/multi-model-agent`](https://www.npmjs.com/package/@zhixuan92/multi-model-agent) — it wraps this library in a local HTTP daemon with client-installable skills for Claude Code, Gemini CLI, Codex CLI, and Cursor.

## Install

```bash
npm install @zhixuan92/multi-model-agent-core
```

Requires Node >= 22. ESM only.

## Quick example

```ts
import { loadConfigFromFile } from '@zhixuan92/multi-model-agent-core/config/load';
import { runTwoPhasePipeline, loadSkill, TaskRegistry } from '@zhixuan92/multi-model-agent-core';

const config = await loadConfigFromFile();
```

## What's inside

- **Provider runners** — Claude (via agent-sdk) and Codex (via CLI subprocess), plus any OpenAI-compatible endpoint
- **Unified task API** — all 11 task types (delegate, audit, review, debug, execute-plan, investigate, research, journal-record, journal-recall, retry, main) flow through a single two-phase pipeline
- **Skill-driven prompts** — each task type has `implement.md` + `review.md` skill files that drive worker behavior
- **Model profile registry** — 32 model families with cost/tier/effort metadata for routing and cost computation
- **Bounded execution** — per-task wall-clock deadlines, idle-stall detection, abort signals, and cost tracking
- **Observability** — structured event envelopes, JSONL logging, telemetry upload with consent rules

## Subpath exports

| Subpath | What |
|---|---|
| `.` | Main entry — providers, task types, pipeline, config, reporting, observability |
| `./config/schema` | `parseConfig`, `multiModelConfigSchema`, `serverConfigSchema` |
| `./config/load` | `loadConfigFromFile`, `loadAuthToken` |
| `./config/model-profile-registry` | `findModelProfile`, `extractCanonicalModelName`, model family enum |
| `./providers/provider-factory` | `createProvider` factory, session safety ceiling |
| `./bounded-execution/activity-tracker` | `ActivityTracker` — heartbeat + stage transitions |
| `./types` | Cross-cutting types (task spec, run result, config, enums) |
| `./reporting/structured-report` | Structured report parsing |
| `./error-codes` | Error code constants |
| `./events/envelope-bus` | `EnvelopeBus` — pub/sub for structured observability |
| `./events/log-writer` | `LogWriter` — JSONL diagnostic sink |
| `./events/task-envelope` | `TaskEnvelopeStore` — per-task event accumulator |
| `./events/telemetry-uploader` | `TelemetryUploader` — wire record upload |
| `./events/stderr-log-subscriber` | `StderrLogSubscriber` — stderr event echo |
| `./events/consent-rules` | `decideConsent` — env / config / default precedence |
| `./events/wire-schema` | Wire record Zod schema (v6) |
| `./events/jsonl-writer` | `JsonlWriter` — append-only JSONL file writer |
| `./research` | Research orchestration + adapters (arxiv, semantic-scholar, github, openalex, crossref, pubmed) |

## Diagnostic logging

Diagnostic logging is OFF by default.

```json
{
  "diagnostics": {
    "log": false,
    "logDir": "/some/path"
  }
}
```

When `diagnostics.log` is `true`, JSONL records are appended to `mmagent-YYYY-MM-DD.jsonl` under `diagnostics.logDir` (defaults to `~/.multi-model/logs/`).

```bash
mmagent serve --log       # persist to JSONL
mmagent logs --follow     # tail + filter
```

## Full documentation

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
