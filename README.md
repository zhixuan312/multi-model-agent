# multi-model-agent

[![npm](https://img.shields.io/npm/v/@zhixuan92/multi-model-agent?label=npm)](https://www.npmjs.com/package/@zhixuan92/multi-model-agent)

Local HTTP service for delegating tool-using work to sub-agents on different LLM providers.

*(Replaced `@zhixuan92/multi-model-agent-mcp` in 3.0.0 — see [CHANGELOG](./CHANGELOG.md).)*

## Why

- **Save 90%+ on implementation labor.** Mechanical work runs on cheaper standard agents; your flagship model stays on architecture and decisions.
- **Structural quality.** Implementation and review run on different agents — different training data, different blind spots. Cross-agent review catches what self-review can't.
- **Client-agnostic.** One daemon serves Claude Code, Gemini CLI, Codex CLI, and Cursor via installable skills. The daemon outlives any individual client session.

## Install

```bash
npm i -g @zhixuan92/multi-model-agent
```

Requires Node >= 22.

## Run

```bash
mmagent serve   # starts on 127.0.0.1:7337 by default
```

Keep this running in the background (or as a user service — see `docs/ops/launchd.md` (TBD)).

## Install skills for your AI client

```bash
mmagent install-skill                           # auto-detect installed clients
mmagent install-skill --target=claude-code      # or gemini, codex, cursor
mmagent install-skill --all-targets             # install for every detected client
mmagent install-skill --uninstall               # remove skills
```

Skills are thin adapters that point HTTP requests at the running daemon. Once installed, your AI client has the full tool set without further configuration.

## Supported clients

**Claude Code** — Skills install to `~/.claude/skills/`. Claude Code picks them up automatically on next session start.

**Gemini CLI** — Skills install to the Gemini CLI skill directory. Requires a Gemini CLI version that supports external skills.

**Codex CLI** — Skills install to `~/.codex/skills/`. Available on next Codex session.

**Cursor** — Skills install as a Cursor extension manifest. Restart Cursor to load them.

## Config

Config file: `~/.multi-model/config.json`

```json
{
  "agents": {
    "standard": {
      "type": "codex",
      "model": "codex-mini-latest"
    },
    "complex": {
      "type": "claude",
      "model": "claude-sonnet-4-20250514"
    }
  },
  "defaults": {
    "timeoutMs": 1800000,
    "maxCostUSD": 10,
    "tools": "full"
  },
  "server": {
    "bind": "127.0.0.1",
    "port": 7337,
    "auth": {
      "tokenFile": "~/.multi-model/auth-token"
    }
  }
}
```

Agent types: `claude`, `codex`, `openai-compatible`. Any OpenAI-compatible endpoint works (MiniMax, DeepSeek, Groq, Together, local vLLM):

```json
{
  "agents": {
    "standard": {
      "type": "openai-compatible",
      "model": "MiniMax-M2",
      "baseUrl": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY"
    },
    "complex": {
      "type": "openai-compatible",
      "model": "gpt-5",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    }
  }
}
```

Config lookup order: `--config <path>` → `MULTI_MODEL_CONFIG` env → `~/.multi-model/config.json`.

## Operator commands

```bash
mmagent serve                   # start daemon
mmagent status                  # show running daemon health and stats
mmagent print-token             # print the current auth token
mmagent install-skill           # install skills (see above)
mmagent install-skill --uninstall   # remove skills
mmagent update-skills           # refresh installed skills after upgrade
```

## Operating mmagent (3.3.0+)

### Upgrading

```
npm install -g @zhixuan92/multi-model-agent@latest
pkill -f "mmagent serve"        # stop the running daemon
mmagent update-skills            # next session of any client respawns it
```

A drift warning prints on `mmagent serve` if installed skills are older than the daemon.

### Health check

```
curl -s http://localhost:7337/health
# {"ok": true, "version": "<installed version>", ...}
```

### Verbose mode

Enable in config (`~/.multi-model/config.json`):

```
{ "diagnostics": { "log": true, "verbose": true } }
```

Verbose mode logs to `~/.multi-model/logs/`. Large request bodies (over 16 KB UTF-8) spill to `~/.multi-model/logs/requests/<batchId>.json`. **Note:** request bodies may include prompts, file paths, and other task content — disable `verbose` for production servers handling sensitive data.

### Token regeneration

```
mmagent print-token              # show current
# delete ~/.multi-model/auth-token and restart to rotate
```

### Troubleshooting

- **Port 7337 already in use** — `lsof -nP -i :7337` to find owner; kill the stale process.
- **Daemon stale after upgrade** — `pkill -f "mmagent serve"`; preflight respawns.
- **Skill version mismatch** — `mmagent update-skills` and restart your client.

### 3.3.0 features at a glance

- `verifyCommand: ["npm run build", "npm test"]` on a TaskSpec — service runs the commands sequentially after committing, captures pass/fail, feeds output to the reviewer.
- `reviewPolicy: "diff_only"` — single-pass review against the diff, no rework loop. Ideal for mechanical refactors (file moves, import path updates, type renames).
- `commits: []` on the terminal envelope — one entry per commit landed by the worker, with `sha`, `subject`, `body`, `filesChanged`, `authoredAt`. Cross-check against `git log`.
- `verification: {status, steps[], totalDurationMs}` on every RunResult — present even when no `verifyCommand` was set (`status: "skipped"`).

## Architecture at a glance

`mmagent serve` runs a loopback HTTP server. Each tool call dispatches to a labor agent (standard or complex), runs a cross-agent review cycle, and returns a structured report. Tasks run in parallel; each has a cost ceiling and wall-clock timeout.

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — layer map, request lifecycle, maintainer migration appendix (post-3.2.0).
- [DIRECTION.md](./DIRECTION.md) — product north star.

## License

MIT — see [`LICENSE`](./LICENSE).
