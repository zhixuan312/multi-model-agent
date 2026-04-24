import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    exclude: ['.worktrees/**', '**/node_modules/**'],
  },
  resolve: {
    alias: [
      {
        find: /^@zhixuan92\/multi-model-agent-core$/,
        replacement: path.resolve(__dirname, 'packages/core/src/index.ts'),
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
