# @zhixuan92/multi-model-agent-mcp

**MCP server for multi-model-agent.** Your AI assistant gets 8 tools for delegating work to cheaper agents — parallel execution, cross-agent review, 90% cost savings.

Works with Claude Code, Codex CLI, Cursor, Gemini CLI, and Claude Desktop.

## Install

```bash
claude mcp add multi-model-agent -s user \
  -- npx -y @zhixuan92/multi-model-agent-mcp serve
```

No install step, no long-running process. Your MCP client spawns it on demand via `npx`. Requires Node >= 22.

## What you get

| Tool | What it does |
|---|---|
| `delegate_tasks` | Dispatch tasks in parallel with full execution control |
| `audit_document` | Audit docs/files for issues — parallel per file |
| `review_code` | Code review with spec + quality pipeline — parallel per file |
| `verify_work` | Verify work against a checklist — parallel per file |
| `debug_task` | Hypothesis-driven debugging with file context |
| `register_context_block` | Store reusable context for later tasks |
| `retry_tasks` | Re-run specific tasks from a previous batch |
| `get_batch_slice` | Fetch output or telemetry from a previous batch |

## Setup & Configuration

See the full setup guide with config examples, client-specific instructions, and auth details:

→ **[github.com/zhixuan312/multi-model-agent](https://github.com/zhixuan312/multi-model-agent#quick-start)**

## License

[MIT](./LICENSE) — Copyright (c) 2026 Zhang Zhixuan
