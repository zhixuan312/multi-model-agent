import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Empirically-verified shape (see Task I-6 in the mcp-apps-desktop plan):
//
// Vite preserves the input path RELATIVE TO ROOT. With a non-default `root`
// of 'src/ui/execution' and a bare relative `input`, the emitted file lands
// three levels too deep at dist/ui/src/ui/execution/execution.html. Using an
// ABSOLUTE `input` path (resolve(__dirname, ...)) avoids that, and the build
// still emits directly into `outDir` as `execution.html`.
//
// `outDir` is relative to `root` (src/ui/execution), so '../../../dist/ui'
// resolves to packages/server/dist/ui — inside the shared dist/ tree also
// populated by tsc, hence `emptyOutDir: false` so this build never wipes
// sibling output (dist/skills, dist/http, etc.).
export default defineConfig({
  root: 'src/ui/execution',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../../../dist/ui',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/ui/execution/execution.html'),
    },
  },
});
