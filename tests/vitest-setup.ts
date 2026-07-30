/**
 * Global test environment setup — runs before every test file.
 *
 * WHY THIS EXISTS. `configure-provider` verifies a codex tier by probing whether the
 * codex CLI is actually spawnable (`codexBinaryAvailable()` in
 * packages/server/src/http/handlers/introspection/configure-provider.ts) — a real
 * `execFileSync('codex', ['--version'])`. That made ~15 tests depend on a globally
 * installed codex binary: green on a maintainer laptop that has one, red on a CI runner
 * or a fresh contributor's machine that does not, with a confusing failure (`body.probe`
 * undefined, because an unverified request never reaches the probe).
 *
 * Point the resolution at the running Node binary instead. It always exists, and
 * `node --version` exits 0, so the availability check answers "present" deterministically
 * on every platform without installing anything.
 *
 * `??=` so an explicit MMA_CODEX_BIN from the environment still wins — that is how you
 * run the suite against a real codex build. The one test that deliberately exercises the
 * codex-ABSENT path (tests/http/configure-provider-probe.test.ts) sets its own
 * non-existent path and restores this value afterwards, so the negative case stays covered.
 */
process.env.MMA_CODEX_BIN ??= process.execPath;
