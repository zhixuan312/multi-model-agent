import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { FileBackedContextBlockStore } from '../../packages/core/src/stores/file-backed-context-block-store.js';

describe('FileBackedContextBlockStore root path', () => {
  it('stores under <homeDir>/.multi-model/context-blocks/<projectHash>/', () => {
    const home = mkdtempSync(join(tmpdir(), 'mma-store-path-'));
    try {
      const store = new FileBackedContextBlockStore('/tmp/some-project-cwd', { homeDir: home });
      const root = (store as unknown as { rootDir: string }).rootDir;
      expect(root.startsWith(join(home, '.multi-model', 'context-blocks') + sep)).toBe(true);
      expect(root.includes('.multi-model-agent')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
