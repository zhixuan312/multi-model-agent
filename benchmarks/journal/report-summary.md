# Journal Deterministic Engine — Benchmark Summary

Generated 2026-07-25 by `tests/perf/journal-engine-benchmark-gates.test.ts`.
Deterministic mechanism benchmark over a seeded 2000-node fixture and a frozen
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
| record latency p50 (ms) | 51.952 | 4.289 | baseline/engine ≥ 3× | 12.1× |
| recall latency p50 (ms) | 51.996 | 4.303 | baseline/engine ≥ 3× | 12.1× |
| record tokens (total) | 3263688 | 4685 | ≥ 80% reduction | 99.9% |
| recall tokens (total) | 3263688 | 4685 | ≥ 80% reduction | 99.9% |
| retrieval mAP | 0.4879 | 1.0000 | engine ≥ baseline | pass |
| mechanical errors | 2 | 0 | engine == 0 | pass |
| rebuild equivalent | true | true | engine == true | pass |
