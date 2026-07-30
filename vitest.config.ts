import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    // Makes the suite hermetic w.r.t. a globally installed codex CLI — see the file's
    // header. Without it, ~15 configure-provider tests pass or fail based on the
    // developer's PATH rather than on the code.
    setupFiles: ['./tests/vitest-setup.ts'],
    // NOTE: tests/perf/ holds the deterministic journal benchmark + gate
    // (tests/perf/journal-engine-benchmark*.test.ts) — they always run, no skips.
    // (The old wall-clock baseline-vs-baseline harness was removed; it compared
    // cross-machine absolute timings and could not run deterministically.)
    exclude: ['**/.mma/**', '**/node_modules/**'],
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
    server: {
      deps: {
        // Inline so vi.mock() can intercept the SDK from source's transitive
        // import; the 0.3.x bundled .mjs isn't mockable while externalized.
        inline: ['@anthropic-ai/claude-agent-sdk'],
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^@zhixuan92\/multi-model-agent-core$/,
        replacement: path.resolve(__dirname, 'packages/core/src/index.ts'),
      },
      {
        find: /^@zhixuan92\/multi-model-agent-core\/research$/,
        replacement: path.resolve(__dirname, 'packages/core/src/research/index.ts'),
      },
      {
        find: /^@zhixuan92\/multi-model-agent-core\/(.+)\.js$/,
        replacement: path.resolve(__dirname, 'packages/core/src/$1.ts'),
      },
      {
        find: /^@zhixuan92\/multi-model-agent-core\/(.+)$/,
        replacement: path.resolve(__dirname, 'packages/core/src/$1.ts'),
      },
      {
        find: /^@zhixuan92\/multi-model-agent\/server$/,
        replacement: path.resolve(__dirname, 'packages/server/src/http/server.ts'),
      },
    ],
  },
});
