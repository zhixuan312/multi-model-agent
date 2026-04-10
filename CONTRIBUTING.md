# Contributing to multi-model-agent

Thanks for your interest in contributing. This is a small, opinionated project — the goal is a focused MCP server that delegates tasks across LLM providers without becoming a kitchen sink. PRs that align with that goal are welcome.

## Quick start

```bash
git clone https://github.com/zhixuan312/multi-model-agent.git
cd multi-model-agent
npm install
npm run build
npm test
```

Requirements:

- Node.js `>= 22`
- npm `>= 10` (ships with Node 22)

## Repo layout

```
packages/
  core/   Library: routing, config, provider runners, tool sandbox.
          Published as @zhixuan92/multi-model-agent-core.
  mcp/    MCP stdio server. Wraps core in a delegate_tasks tool.
          Published as @zhixuan92/multi-model-agent-mcp.
tests/    Vitest suite. Mirrors the src/ tree under each package.
scripts/  Standalone Node scripts for poking individual runners
          against live APIs (smoke tests, not part of CI).
```

The two packages are linked via npm workspaces; `npm install` from the repo root sets up the symlinks.

## Common commands

| Command | What it does |
| --- | --- |
| `npm run build` | TypeScript compile both packages (writes to `packages/*/dist`) |
| `npm test` | Run the full Vitest suite once |
| `npm run test:watch` | Watch mode |
| `npm run serve` | Start the MCP server on stdio (uses the freshly built `dist/`) |
| `npx vitest run tests/some.test.ts` | Run a single test file |

**Always run both `npm run build` and `npm test` before opening a PR** — TypeScript errors that don't surface in tests will surface in the build.

## Coding conventions

- **TypeScript, ESM only.** All imports use `.js` extensions even in `.ts` source.
- **Zod for runtime validation** at every system boundary (config files, MCP tool inputs).
- **No backwards-compatibility shims.** This is a 0.x project; if you change a contract, update the call sites and the tests in the same PR.
- **Mock providers in tests.** Never call real LLM APIs from `tests/`. Use the `vi.mock(...)` patterns already in `tests/runners/*.test.ts` for runner-level tests, and the simple `mockProvider` / `failProvider` helpers in `tests/delegate.test.ts` for higher-level tests.
- **Sandbox by default.** File tools enforce `cwd-only` confinement (path traversal + symlink checks). Anything that loosens this needs an explicit reason and a test.
- **Commit messages**: Conventional Commits style — `feat(scope):`, `fix(scope):`, `test(scope):`, `chore:`, `docs:`. The scope is usually the package or subsystem (`codex-runner`, `routing`, `cli`, `auth`).

## Adding a new provider

The core abstractions live in `packages/core/src/`:

1. **Provider config schema** — add a Zod schema in `packages/core/src/config/schema.ts` and a TypeScript interface in `packages/core/src/types.ts`.
2. **Runner** — implement a `run<Provider>(prompt, options, providerConfig, defaults): Promise<RunResult>` function under `packages/core/src/runners/`. Mirror the shape of `claude-runner.ts` or `codex-runner.ts`.
3. **Tool adapter** — if your provider's SDK has its own tool format, add an adapter under `packages/core/src/tools/` that converts our `ToolImplementations` to that format.
4. **Provider factory** — wire the new type into `packages/core/src/provider.ts` so `createProvider()` dispatches to your runner.
5. **Model profiles** — add tier and cost defaults for known model names to `packages/core/src/routing/model-profiles.json` so the routing matrix knows what your provider can handle.
6. **Tests** — add a `tests/runners/<name>-runner.test.ts` that mocks the provider's SDK at the module boundary (see `tests/runners/claude-runner.test.ts` for a worked example using `vi.mock` with `importOriginal`).

## Testing notes

- Tests run with Vitest globals enabled — no need to import `describe` / `it` / `expect`.
- Test files mirror the source tree: `packages/core/src/foo/bar.ts` → `tests/foo/bar.test.ts`.
- For runner tests that mock SDKs: use `vi.mock(specifier, async (importOriginal) => { ... })` so you keep the rest of the SDK exports intact. Replacing the whole module with a partial object will break the runner's adapter imports.
- Use `vi.clearAllMocks()` (not `vi.restoreAllMocks()`) in `beforeEach` for runner tests — `restoreAllMocks` wipes the mock factory's `vi.fn()` instances and breaks captured references.

## Reporting bugs and security issues

- **Bugs and feature requests**: open a GitHub issue. Include the version, the relevant config (with secrets redacted), and steps to reproduce.
- **Security issues**: please do NOT open a public issue. Email `zhangzhixuan312@gmail.com` with details and reproduction steps. I'll respond within a few days.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
