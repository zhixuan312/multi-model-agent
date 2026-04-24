// Pins extractPlanSection behavior — Ch 6 moves it into
// run-tasks/plan-extraction.ts; this contract test guards the public
// signature + parsing semantics (heading match, nested heading boundary,
// 10KB truncation, missing-section returns undefined).
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPlanSection } from '@zhixuan92/multi-model-agent-core/run-tasks';

describe('contract: plan section extraction', () => {
  it('extracts the exact task heading and stops at the next same-or-higher heading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-plan-extract-'));
    try {
      const file = join(dir, 'plan.md');
      writeFileSync(
        file,
        [
          '# Plan',
          '',
          '## Task 1: First thing',
          'Task 1 body',
          '### Sub heading',
          'still task 1',
          '',
          '## Task 2: Second thing',
          'Task 2 body',
          '',
          '# Another top level',
          'outside',
        ].join('\n'),
      );

      const section = await extractPlanSection([file], 'Task 1: First thing', dir);
      expect(section).toBeDefined();
      expect(section).toContain('Task 1 body');
      expect(section).toContain('### Sub heading');
      expect(section).toContain('still task 1');
      expect(section).not.toContain('Task 2 body');
      expect(section).not.toContain('outside');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when the heading is not found', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-plan-extract-'));
    try {
      const file = join(dir, 'plan.md');
      writeFileSync(file, '# Plan\n\n## Task A\nbody');
      const section = await extractPlanSection([file], 'Task Z: missing', dir);
      expect(section).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates sections longer than the 10KB cap with a marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-plan-extract-'));
    try {
      const file = join(dir, 'plan.md');
      const body = 'x'.repeat(15_000);
      writeFileSync(file, `# Plan\n\n## Task BIG\n${body}\n`);
      const section = await extractPlanSection([file], 'Task BIG', dir);
      expect(section).toBeDefined();
      expect(section!.length).toBeLessThan(11_000);
      expect(section).toContain('[truncated at 10KB]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no plan files can be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-plan-extract-'));
    try {
      const section = await extractPlanSection([join(dir, 'nope.md')], 'anything', dir);
      expect(section).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans multiple plan files in order and returns first match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-plan-extract-'));
    try {
      const f1 = join(dir, 'a.md');
      const f2 = join(dir, 'b.md');
      writeFileSync(f1, '# A\n\n## Unrelated\nbody');
      writeFileSync(f2, '# B\n\n## Target\nfrom B');
      const section = await extractPlanSection([f1, f2], 'Target', dir);
      expect(section).toBeDefined();
      expect(section).toContain('from B');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
