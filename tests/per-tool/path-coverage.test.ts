import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';

// register-context-block test is restored by Phase F5 of the v4 engine wiring plan
// (StagePlan unification). Not listed here until that phase completes.
// 'audit' per-tool test deleted in Task A1 (legacy-cleanup); active audit
// integration coverage lives in tests/per-task/audit*.test.ts,
// tests/contract/http/audit.test.ts, and tests/server/handlers/tools/audit.test.ts.
// 'review' per-tool test deleted in Task A2 (legacy-cleanup); active review
// integration coverage lives in tests/per-task/review*.test.ts,
// tests/contract/http/review.test.ts, and tests/server/handlers/tools/review.test.ts.
// 'verify' per-tool test deleted in Task A3 (legacy-cleanup); active verify
// integration coverage lives in tests/per-task/verify*.test.ts,
// tests/contract/http/verify.test.ts, and tests/server/handlers/tools/verify.test.ts.
// 'delegate' per-tool test deleted in Task A5 (legacy-cleanup); active delegate
// integration coverage lives in tests/delegate*.test.ts,
// tests/contract/http/delegate.test.ts, and tests/server/handlers/tools/delegate.test.ts.
const expectedTools = ['execute-plan', 'investigate', 'research', 'retry'];
const presentTests = readdirSync(new URL('.', import.meta.url)).filter(f => f.endsWith('.test.ts') && f !== 'path-coverage.test.ts').map(f => f.replace('.test.ts', ''));

describe('per-tool path coverage', () => {
  it('every v4.0 tool has a per-tool integration test', () => {
    for (const tool of expectedTools) {
      expect(presentTests).toContain(tool);
    }
  });
});
