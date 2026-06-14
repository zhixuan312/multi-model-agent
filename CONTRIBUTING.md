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
  core/    Library: config, providers, unified task pipeline, skills,
           bounded execution, observability, research.
           Published as @zhixuan92/multi-model-agent-core.
  server/  HTTP daemon + CLI + installable skill bundles.
           Published as @zhixuan92/multi-model-agent.
tests/    Vitest suite. Mirrors the src/ tree under each package.
          tests/contract/ holds public-contract goldens — touch with care.
docs/     ARCHITECTURE.md (layered map) + SKILL_WRITING_GUIDELINES.md.
```

The two packages are linked via npm workspaces; `npm install` from the repo root sets up the symlinks. Both packages bump together on every release.

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
- **Zod for runtime validation** at every system boundary (config files, HTTP inputs, telemetry events).
- **No backwards-compatibility shims.** Breaking changes are expected; if you change a contract, update the call sites, contract goldens, and tests in the same PR.
- **Mock providers in tests.** Never call real LLM APIs from `tests/`. Use `mockProvider` / `failProvider` helpers in `tests/contract/fixtures/mock-providers.ts`.
- **Sandbox by default.** Task types enforce `cwd-only` confinement (path traversal + symlink checks).
- **Contract goldens are the public-contract ratchet.** Changes to `tests/contract/**` goldens encode the HTTP envelope, route manifest, observability event set, and skill surface. Updating a golden must be intentional and justified.

## Adding a new provider

1. **Provider runner** — implement under `packages/core/src/providers/<name>.ts`. Follow the shape of `claude.ts` / `codex.ts`.
2. **Provider factory** — wire the new type into `packages/core/src/providers/provider-factory.ts` so `createProvider()` dispatches to your runner.
3. **Config schema** — add a Zod agent schema variant in `packages/core/src/config/schema.ts`.
4. **Model profiles** — add tier and pricing entries to `packages/core/src/model-profiles.json`.
5. **Tests** — add provider tests that mock the SDK at the module boundary.

## Adding a new task type

All task types flow through the unified `POST /task` endpoint via a type discriminator:

1. **Type registry** — add to `TASK_TYPES` in `packages/core/src/unified/type-registry.ts` and add a `TYPE_REGISTRY` entry.
2. **Zod schema** — add a schema variant in `packages/core/src/unified/task-input-schema.ts`.
3. **Skill files** — add `packages/core/src/skills/<name>/implement.md` + `review.md`.
4. **Caller skill** (optional) — add `packages/server/src/skills/mma-<name>/SKILL.md`.
5. **Report parser** (optional) — add `packages/core/src/reporting/parse-<name>-report.ts` + `compose-<name>-headline.ts` if the output shape is bespoke.
6. **Contract golden** — add the route to `tests/contract/goldens/routes.json`.

Skills follow the conventions in [docs/SKILL_WRITING_GUIDELINES.md](./docs/SKILL_WRITING_GUIDELINES.md).

## Testing notes

- Tests run with Vitest globals enabled — no need to import `describe` / `it` / `expect`.
- Test files mirror the source tree: `packages/core/src/foo/bar.ts` → `tests/foo/bar.test.ts`.
- Use `env -u MMAGENT_AUTH_TOKEN` when running tests to avoid env override breaking server-handler tests.

## Reporting bugs and security issues

- **Bugs and feature requests**: open a GitHub issue. Include the version, the relevant config (with secrets redacted), and steps to reproduce.
- **Security issues**: please do NOT open a public issue. Email `zhangzhixuan312@gmail.com` with details and reproduction steps.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
