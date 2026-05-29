import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PRIVACY.md ↔ schema sync', () => {
  it('lists every V4 UploadBatch + event field', () => {
    const repoRoot = join(__dirname, '..', '..');
    const md = readFileSync(join(repoRoot, 'PRIVACY.md'), 'utf8');
    const expected = [
      'installId', 'schemaVersion', 'mmagentVersion', 'os', 'nodeMajor',
      'route', 'client', 'terminalStatus', 'implementerModel', 'eventId',
      'totalDurationMs', 'totalCostUSD', 'costDeltaVsMainUSD', 'mainCostUSD',
      'inputTokens', 'outputTokens',
      'cachedReadTokens', 'cachedNonReadTokens',
      'tierUsage', 'mainModel', 'round',
      'concernCount', 'escalationCount', 'fallbackCount',
      'stallCount', 'taskMaxIdleMs',
      'reviewPolicy',
      'agentType', 'toolMode', 'capabilities',
      'verdict', 'errorCode', 'mainModelFamily',
    ];
    for (const f of expected) {
      const occurrences = (md.match(new RegExp(`\\b${f}\\b`, 'g')) || []).length;
      expect(occurrences, `${f} should appear at least once in PRIVACY.md`).toBeGreaterThan(0);
    }
  });
});
