import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchPersister } from '../../packages/core/src/reporting/batch-persister.js';

describe('BatchPersister', () => {
  it('persists state to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-'));
    const p = new BatchPersister();
    const path = p.persist('batch-1', { tasks: [] }, dir);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ tasks: [] });
  });
});
