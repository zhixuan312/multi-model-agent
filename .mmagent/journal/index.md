| id | date | status | title | tags |
| --- | --- | --- | --- | --- |
| 0001 | 2026-05-24 | adopted | Derive completion from objective lifecycle signals | completion-gating, telemetry, lifecycle, worker-self-assessment, objective-signals, read-routes, criteria, smoke-testing, end-to-end, smoke-harness, telemetry-sinks, plumbing |
| 0002 | 2026-05-24 | adopted | Enforce no backward compatibility in greenfield development | development-mode, no-backward-compat, cleanup, dead-code, one-implementation-per-concept |
| 0003 | 2026-05-24 | adopted | Close caller-facing enums at the HTTP boundary | enums, zod, validation, api-contract, drift-detection |
| 0004 | 2026-05-24 | adopted | Centralize cost accounting in one pure pricing function | cost, pricing, tokens, telemetry, pure-function, normalization |
| 0005 | 2026-05-24 | adopted | Preserve unknown values as null in telemetry | telemetry, honest-null, cost-attribution, data-integrity, pricing |
| 0006 | 2026-05-24 | adopted | Treat telemetry schema version as a data-loss switch | telemetry, schema-version, wire-schema, data-loss, greenfield |
| 0007 | 2026-05-24 | adopted | Attribute stage model and cost to the tier that ran it | telemetry, cost-attribution, per-stage, model-attribution, tiers |
| 0008 | 2026-05-24 | adopted | Keep one canonical read path per lifecycle fact | lifecycle, commit-gate, review-gate, single-source-of-truth, state-mirrors |
| 0009 | 2026-05-24 | adopted | Enforce reviewer and implementer separation by tier | code-review, cross-tier, reviewer-separation, tiers, quality |
| 0010 | 2026-05-24 | adopted | Gate reviewer verdict overrides on severity | code-review, reviewer-verdict, severity, fail-safe, parsing |
| 0011 | 2026-05-24 | adopted | Share one structured-output contract and surface parser drops | findings-format, structured-output, parsing, prompts, observability, validation-warnings, read-routes |
| 0012 | 2026-05-24 | superseded | Serialize same-repo write dispatch to protect shared worktrees | concurrency, dispatch, same-repo, serialization, data-loss, git, write-routes |
| 0013 | 2026-05-24 | adopted | Prefer same-repo parallel dispatch with scoped git commits | concurrency, dispatch, parallel, commit-mutex, git-attribution, pathspec, same-repo, git |
| 0014 | 2026-05-24 | adopted | Accumulate provider token usage incrementally during streaming turns | providers, token-usage, telemetry, streaming, partial-runs, claude, openai-compatible |
| 0015 | 2026-05-24 | adopted | Separate labor from judgment with a deterministic research orchestrator | research, labor-vs-judgment, two-turn, orchestrator, determinism, query-plan, evidence-pack |
| 0016 | 2026-05-24 | adopted | Track file activity only from provider-proven events | observability, headline, honesty, file-tracking, no-heuristics, provider-events |
| 0017 | 2026-05-24 | adopted | Treat disabled network tests as missing critical-path coverage | testing, ssrf, network-gated, ci, regression, deterministic-tests, web-fetch, dns |
| 0018 | 2026-05-24 | adopted | Confine by default, canonicalize paths, and fail before allocation | security, sandbox, cwd-only, path-traversal, realpath, resource-limits, symlinks, loopback, dns-rebinding |
| 0019 | 2026-05-24 | adopted | Treat runtime imports as shipping dependencies and validate from a clean published artifact | packaging, dependencies, peer-deps, npm, publishing, clean-install, hoisting, npx, bins |
| 0020 | 2026-05-24 | adopted | Route all lifecycle control through the single invocation surface | architecture, product, invocation-path, mcp, skills, disable, adapters, daemon |
| 0021 | 2026-05-24 | superseded | Bound delegation spend with per-task maxCostUSD ceilings | cost, budgets, max-cost-usd, cost-caps, guards, lifecycle, delegation-spend |
| 0022 | 2026-05-24 | adopted | Prefer focus and explicit user budgets over engine cost caps | cost, budgets, focus, autonomous-execution, no-cost-caps, api-contract, completion |
| 0023 | 2026-06-03 | adopted | Default the complex tier to Sonnet on route-weighted review quality | benchmark, model-selection, complex-tier, read-routes, tiers, code-review, cost |
| 0024 | 2026-06-03 | adopted | The worker harness, not the model, caps read-route quality at the top end | harness, benchmark, criteria, read-routes, model-selection, plan-audit |
| 0025 | 2026-06-03 | adopted | Terminal-stage lifecycle bug catalog from the cross-model audit | bugs, terminal-stage, lifecycle, telemetry, contract-tests, benchmark |
| 0026 | 2026-06-08 | adopted | Forge is the human-facing harness for the MMA SDLC flow | forge, decision, sdlc, product, mma-integration |
| 0027 | 2026-06-08 | adopted | Build Forge as one consolidated Next.js app in its own repo | forge, architecture, decision, nextjs, repo-boundary |
| 0028 | 2026-06-08 | adopted | Forge's server tier calls co-located mmagent over HTTP, never links mma-core | forge, architecture, mma-integration, http-boundary, decision |
| 0029 | 2026-06-08 | adopted | Forge spec Q&A is a code-orchestrated workflow, not an autonomous agent | forge, architecture, decision, workflow, structured-outputs, mma-integration |
| 0030 | 2026-06-08 | adopted | Per-component dynamic satisfaction gate for Forge spec Q&A | forge, design, decision, sdlc, satisfaction-gate, mma-integration |
| 0031 | 2026-06-08 | adopted | Forge stack — all-latest versions as of 2026-06-08 | forge, stack, decision, dependencies |
| 0032 | 2026-06-08 | adopted | Forge persists resumable workflow state in Postgres via Drizzle | forge, architecture, decision, state, drizzle, postgres, sdlc |
| 0033 | 2026-06-08 | adopted | Forge build plan — staged sub-projects, Foundation+Spec first, Execute last and highest-risk | forge, decision, sdlc, build-plan, mma-integration, security |
| 0034 | 2026-06-08 | adopted | Record Forge design decisions to the journal before authoring a formal spec | forge, process, decision |
| 0035 | 2026-06-08 | adopted | One Project is one flow with a design/build regime split at the spec freeze | forge, decision, flow, sdlc, freeze, phase-machine |
| 0036 | 2026-06-08 | adopted | Every MMA call is scoped to exactly one repo; Plan decomposes along repo boundaries | forge, decision, architecture, one-repo-per-call, multi-repo, mma-integration, write-routes |
| 0037 | 2026-06-08 | adopted | Single-team tenancy — one shared agent credential, member identity for audit, project-level visibility | forge, tenancy, decision, architecture, security, visibility, state |
| 0038 | 2026-06-08 | adopted | Public Projects share equal rights; spec components map to role owners | forge, spec, collaboration, decision, flow, mermaid, satisfaction-gate |
| 0039 | 2026-06-08 | adopted | Forge design docs live in the Forge repo design/ dir, not docs/superpowers | forge, docs, process, decision, repo-boundary |
