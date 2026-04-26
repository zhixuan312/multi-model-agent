import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PRIVACY.md ↔ schema sync', () => {
  it('lists every UploadBatch + event field exactly once', () => {
    const repoRoot = join(__dirname, '..', '..');
    const md = readFileSync(join(repoRoot, 'PRIVACY.md'), 'utf8');
    const expected = [
      'installId', 'schemaVersion', 'mmagentVersion', 'os', 'nodeMajor', 'language', 'tzOffsetBucket',
      'route', 'client', 'terminalStatus', 'implementerModel',
      'costBucket', 'durationBucket', 'fileCountBucket',
      'verdict', 'errorCode',
    ];
    for (const f of expected) {
      const occurrences = (md.match(new RegExp(`\\b${f}\\b`, 'g')) || []).length;
      expect(occurrences, `${f} should appear at least once in PRIVACY.md`).toBeGreaterThan(0);
    }
  });
});
