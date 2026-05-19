// research/index.ts — internal barrel. The /research route reaches its
// concrete implementations via direct path imports from the implement-stage
// handler; this barrel exists only as a navigation aid and exposes nothing
// public to package consumers.
//
// Intentionally empty: do NOT export adapter/brave/fetch internals — they
// are not part of the package's public API.
export {};
