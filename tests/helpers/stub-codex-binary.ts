/**
 * Point `MMA_CODEX_BIN` at the Node binary for the importing test file.
 *
 * `configure-provider` verifies a codex tier by REALLY spawning `codex --version`
 * (`codexBinaryAvailable()` in the handler), so without this a test passes or fails according
 * to whether the machine happens to have codex on PATH — and it fails confusingly, on
 * `body.probe` being undefined, because an unverified request never reaches the probe. Node
 * always exists and `node --version` exits 0.
 *
 * DELIBERATELY per-file, not a global `setupFiles` hook. A global override also reaches tests
 * that drive a real `CodexCliSession`, which writes an instruction to the spawned process's
 * stdin — against a process that is not codex, that write EPIPEs and fails the run
 * intermittently even when every test passes. Importing this module is how a file opts in.
 *
 * `??=`, so an operator who set MMA_CODEX_BIN to a real codex keeps it.
 *
 * Extracted from four verbatim copies (three `tests/http/configure-provider*` files and
 * `tests/server/handlers/configure-provider-smoke`), each carrying this same fifteen-line
 * rationale. The reasoning is worth keeping and worth keeping ONCE: the day the global-hook
 * tradeoff changes, four copies is four chances to leave one saying the opposite.
 */
process.env.MMA_CODEX_BIN ??= process.execPath;
