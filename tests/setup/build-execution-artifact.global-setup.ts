import { execFileSync } from 'node:child_process';

/**
 * Vitest `globalSetup` — runs ONCE in the main process before any worker/fork starts,
 * regardless of `pool: 'forks'` / `maxForks`. This is the ONLY place in the whole suite that
 * invokes a Vite build.
 *
 * Why it lives here rather than in the tests that need it: the built-artifact proofs assert
 * against the REAL `dist/ui/execution.html`, so something must build it. Doing that inside a
 * test file would either race (two forks building the same output path concurrently) or —
 * far worse — reach for `pnpm build`, which chains `prebuild`'s `rm -rf dist` and would
 * delete the compiled output other tests are reading. No test file may run `pnpm build`,
 * `npm run build`, or remove `dist/`.
 *
 * `vite.ui.config.ts` sets `emptyOutDir: false`, so this writes `dist/ui/execution.html`
 * without disturbing any other `dist/` content, and is idempotent for a fixed source.
 */
export default async function setup(): Promise<void> {
  execFileSync('npx', ['vite', 'build', '--config', 'vite.ui.config.ts'], {
    cwd: 'packages/server',
    stdio: 'pipe',
  });
}
