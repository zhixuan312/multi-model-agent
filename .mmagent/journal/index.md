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
