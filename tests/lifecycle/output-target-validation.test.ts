import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOutputTargets } from '@zhixuan92/multi-model-agent-core/bounded-execution/file-artifact-check';

// Real temp files instead of `vi.mock('fs')` (sticky process-global mock under
// Bun that leaked into later filesystem tests).

describe('output-target validation (post-task helper contract)', () => {
  let dir: string;
  let present: string;
  let absent: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mma-output-target-'));
    present = join(dir, 'present.ts');
    absent = join(dir, 'absent.ts');
    writeFileSync(present, '// exists', 'utf8');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns missing paths when targets are absent', () => {
    expect(checkOutputTargets([present, absent])).toEqual([absent]);
  });

  it('returns empty array when all targets exist', () => {
    expect(checkOutputTargets([present])).toEqual([]);
  });

  it('returns empty array on empty input', () => {
    expect(checkOutputTargets([])).toEqual([]);
  });
});
