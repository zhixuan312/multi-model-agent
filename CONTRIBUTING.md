# Contributing to multi-model-agent

Thanks for your interest in contributing. This is a small, opinionated project — the goal is a focused HTTP daemon that delegates tasks across LLM providers without becoming a kitchen sink. PRs that align with that goal are welcome.

Read [DIRECTION.md](./DIRECTION.md) first; it's the north star for what we build, why, and what we refuse.

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
  core/    Library: intake, routing, runners, executors, lifecycle, telemetry.
           Published as @zhixuan92/multi-model-agent-core.
  server/  HTTP daemon + CLI + installable skill bundles.
           Published as @zhixuan92/multi-model-agent.
tests/    Vitest suite. Mirrors the src/ tree under each package.
          tests/contract/ holds public-contract goldens — touch with care.
docs/     ARCHITECTURE.md (layered map) + SKILL_WRITING_GUIDELINES.md.
```

The two packages are linked via npm workspaces; `npm install` from the repo root sets up the symlinks. The server depends on the core package via `^<version>`, version-locked in lockstep — both bump together on every release.

The deprecated `@zhixuan92/multi-model-agent-mcp` package (the pre-3.0.0 stdio MCP server) lives on a separate `release/2.8.1-mcp-deprecation-stub` branch and is not part of normal development.

## Common commands

| Command | What it does |
| --- | --- |
| `npm run build` | TypeScript compile both packages (writes to `packages/*/dist`) |
| `npm test` | Run the full Vitest suite once |
| `npm run test:watch` | Watch mode |
| `npm run serve` | Start the HTTP daemon on `127.0.0.1:7337` (uses the freshly built `dist/`) |
| `npx vitest run tests/some.test.ts` | Run a single test file |

**Always run both `npm run build` and `npm test` before opening a PR** — TypeScript errors that don't surface in tests will surface in the build.

## Coding conventions

- **TypeScript, ESM only.** All imports use `.js` extensions even in `.ts` source.
- **Zod for runtime validation** at every system boundary (config files, HTTP tool inputs, telemetry events).
- **No backwards-compatibility shims.** Breaking changes are expected; if you change a contract, update the call sites, contract goldens, and tests in the same PR.
- **Mock providers in tests.** Never call real LLM APIs from `tests/`. Use the `vi.mock(...)` patterns in `tests/runners/*.test.ts` for runner-level tests, and the `mockProvider` / `failProvider` helpers in `tests/contract/fixtures/mock-providers.ts` for higher-level tests.
- **Sandbox by default.** File tools enforce `cwd-only` confinement (path traversal + symlink checks). Anything that loosens this needs an explicit reason and a test.
- **Contract goldens are the public-contract ratchet.** Changes to `tests/contract/**` goldens encode the HTTP envelope, route manifest, observability event set, and skill surface. Updating a golden must be intentional and justified in the PR description.
- **Commit messages**: Conventional Commits style — `feat(scope):`, `fix(scope):`, `test(scope):`, `chore:`, `docs:`. The scope is usually the package or subsystem (`server`, `runner`, `delegate`, `tools`, `skills`, `cli`, `auth`).

## Adding a new provider

The core abstractions live in `packages/core/src/`:

1. **Provider config schema** — add a Zod schema in `packages/core/src/config/schema.ts` and a TypeScript interface in `packages/core/src/types.ts`.
2. **Runner** — implement a `run<Provider>(...)` function under `packages/core/src/runners/`. Mirror the shape of `claude-runner.ts` / `codex-runner.ts` / `openai-runner.ts`. Emit canonical `CanonicalUsage` (`inputTokens` excludes cache; `cachedReadTokens` and `cachedCreationTokens` are separate).
3. **Tool adapter** — if your provider's SDK has its own tool format, add an adapter under `packages/core/src/tools/` that converts our `ToolImplementations` to that format.
4. **Provider factory** — wire the new type into `packages/core/src/provider.ts` so `createProvider()` dispatches to your runner.
5. **Model profiles** — add tier and pricing entries for known model names to `packages/core/src/routing/model-profiles.json` so the routing matrix knows what your provider can handle.
6. **Tests** — add a `tests/runners/<name>-runner.test.ts` that mocks the provider's SDK at the module boundary (see `tests/runners/claude-runner.test.ts` using `vi.mock` with `importOriginal`).

## Adding a new tool/preset

Fill the layered stack top-to-bottom (see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)):

1. **Tool schema** — `packages/core/src/tool-schemas/<name>.ts` (Zod input + output)
2. **Compiler** — `packages/core/src/intake/compilers/<name>.ts`
3. **Executor** — `packages/core/src/executors/<name>.ts`
4. **HTTP handler** — `packages/server/src/http/handlers/tools/<name>.ts` and route registration in `packages/server/src/http/server.ts`
5. **Skill** — `packages/server/src/skills/mma-<name>/SKILL.md` (caller-facing prompt)
6. **Contract goldens** — add the route to `tests/contract/goldens/routes.json` and per-stage goldens under `tests/contract/goldens/endpoints/<name>-<stage>.json`

Skills follow the conventions in [docs/SKILL_WRITING_GUIDELINES.md](./docs/SKILL_WRITING_GUIDELINES.md).

## Testing notes

- Tests run with Vitest globals enabled — no need to import `describe` / `it` / `expect`.
- Test files mirror the source tree: `packages/core/src/foo/bar.ts` → `tests/foo/bar.test.ts`.
- For runner tests that mock SDKs: use `vi.mock(specifier, async (importOriginal) => { ... })` so you keep the rest of the SDK exports intact. Replacing the whole module with a partial object breaks the runner's adapter imports.
- Use `vi.clearAllMocks()` (not `vi.restoreAllMocks()`) in `beforeEach` for runner tests — `restoreAllMocks` wipes the mock factory's `vi.fn()` instances and breaks captured references.

## Reporting bugs and security issues

- **Bugs and feature requests**: open a GitHub issue. Include the version, the relevant config (with secrets redacted), and steps to reproduce.
- **Security issues**: please do NOT open a public issue. Email `zhangzhixuan312@gmail.com` with details and reproduction steps. I'll respond within a few days.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
