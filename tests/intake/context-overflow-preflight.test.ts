import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateContextSize, checkOverflow } from '../../packages/core/src/intake/context-overflow-estimator.js';

describe('estimateContextSize', () => {
  it('sums baseInstructions + filePath bytes/3.5 + reservedCompletion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-est-'));
    writeFileSync(join(dir, 'a.ts'), 'x'.repeat(3500)); // ~1000 tokens
    try {
      const est = estimateContextSize({
        filePaths: [join(dir, 'a.ts')],
        contextBlockLengthsChars: [],
        baseInstructionsTokens: 4000,
        reservedCompletionTokens: 64000,
      });
      expect(est).toBe(4000 + Math.ceil(3500 / 3.5) + 64000); // 69000
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses ceil for both filePath AND context-block contributions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mma-est-'));
    writeFileSync(join(dir, 'a.ts'), 'x'); // 1 byte → ceil(1/3.5) = 1 token
    try {
      const est = estimateContextSize({
        filePaths: [join(dir, 'a.ts')],
        contextBlockLengthsChars: [10], // ceil(10/3.5) = 3 tokens
        baseInstructionsTokens: 0,
        reservedCompletionTokens: 0,
      });
      expect(est).toBe(1 + 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkOverflow', () => {
  it('returns null when estimate fits', () => {
    const r = checkOverflow({
      estimatedTokens: 1000,
      modelCap: 100000,
      tier: 'standard',
      model: 'test-model',
      contributors: [{ kind: 'filePath', path: 'a.ts', estimatedTokens: 1000 }],
    });
    expect(r).toBeNull();
  });

  it('returns error envelope when estimate exceeds cap', () => {
    const r = checkOverflow({
      estimatedTokens: 1_634_000,
      modelCap: 1_048_576,
      tier: 'standard',
      model: 'deepseek-v4-pro',
      contributors: [
        { kind: 'filePath', path: 'src/runner.ts', estimatedTokens: 850000 },
        { kind: 'contextBlock', id: 'abc-123', estimatedTokens: 600000 },
        { kind: 'filePath', path: 'tests/integration.test.ts', estimatedTokens: 100000 },
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.error).toBe('context_overflow_predicted');
    expect(r!.details.estimatedTokens).toBe(1_634_000);
    expect(r!.details.modelCap).toBe(1_048_576);
    expect(r!.details.biggestContributors[0]!.estimatedTokens).toBe(850000); // sorted descending
    expect(r!.details.recoveryHints.length).toBeGreaterThan(0);
  });
});
