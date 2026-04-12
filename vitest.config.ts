import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    exclude: ['.worktrees/**', '**/node_modules/**'],
  },
  resolve: {
    alias: {
      '@zhixuan92/multi-model-agent-core/provider': path.resolve(__dirname, 'packages/core/src/provider.ts'),
    },
  },
});
