# Journal Deterministic Engine — Benchmark Summary

Generated 2026-07-26 by `tests/perf/journal-engine-benchmark-gates.test.ts`.
Deterministic mechanism benchmark over a seeded 3000-node fixture and a frozen
query set — no LLM, no server, no network.

- **baseline** = simulated pre-change cost model: read + parse the whole corpus
  and linear keyword-scan it on every operation; the entire catalog + all node
  bodies are injected per operation; retrieval has no topic prefilter.
- **engine** = the new path measured through the REAL public retrieval calls
  the HTTP route makes (`searchCandidatesForRecord` / `searchCandidatesForRecall`):
  `JournalIndexStore` FTS/BM25 + tag + graph retrieval returning top-K
  candidates; only the top-K candidate text is injected; the per-query freshness
  check is a cheap node-count comparison (`ensureFresh`), so latency reflects
  the FTS-indexed query rather than an O(N) stat sweep; writes are applied by the
  deterministic `JournalStore`.

| Metric | baseline | engine | gate | result |
|---|---:|---:|---|---|
| record latency p50 (ms) | 75.793 | 6.726 | baseline/engine ≥ 3× | 11.3× |
| recall latency p50 (ms) | 75.096 | 7.125 | baseline/engine ≥ 3× | 10.5× |
| record tokens (total) | 4895172 | 4687 | ≥ 80% reduction | 99.9% |
| recall tokens (total) | 4895172 | 4687 | ≥ 80% reduction | 99.9% |
| retrieval mAP | 0.4804 | 1.0000 | engine ≥ baseline | pass |
| mechanical errors | 2 | 0 | engine == 0 | pass |
| rebuild equivalent | true | true | engine == true | pass |
