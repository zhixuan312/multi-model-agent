import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOutputTargets } from '@zhixuan92/multi-model-agent-core/bounded-execution/file-artifact-check';

// Uses REAL temp files rather than `vi.mock('fs')`. Under Bun, mock.module is
// process-global and sticky — mocking fs here leaked into every later test that
// touches the filesystem. checkOutputTargets only does existsSync, so a real
// temp dir exercises it exactly with zero global state.

describe('checkOutputTargets', () => {
  let dir: string;
  let present: string;
  let absent: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-artifact-'));
    present = join(dir, 'present.ts');
    absent = join(dir, 'absent.ts');
    writeFileSync(present, '// exists', 'utf8');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty array when all targets exist', () => {
    expect(checkOutputTargets([present])).toEqual([]);
  });

  it('returns the missing paths when some are absent', () => {
    expect(checkOutputTargets([present, absent])).toEqual([absent]);
  });

  it('returns empty array on empty input', () => {
    expect(checkOutputTargets([])).toEqual([]);
  });
});
