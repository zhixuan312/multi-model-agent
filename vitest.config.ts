import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    exclude: ['.worktrees/**', '**/node_modules/**', 'tests/perf/**'],
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
        find: /^@zhixuan92\/multi-model-agent-core\/run-tasks$/,
        replacement: path.resolve(__dirname, 'packages/core/src/run-tasks/index.ts'),
      },
      {
        find: /^@zhixuan92\/multi-model-agent-core\/run-tasks\/verify-stage\.js$/,
        replacement: path.resolve(__dirname, 'packages/core/src/lifecycle/handlers/verify-stage.ts'),
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
