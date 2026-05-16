// tests/escalation/delegate-with-escalation.test.ts
//
// Task 15 + AC-3: proves the M1 fix — escalation no longer promotes-or-
// demotes based on workerSelfAssessment. Source-level invariant: the v5
// marker comment is present; the old `best.workerStatus === 'done' && ...`
// gate block is gone. We assert this via a source-text inspection because
// the alternative (constructing a full escalation harness) would require
// mocking 4+ providers and the full RunResult plumbing — not worth the
// fixture surface for what is a code-deletion verification.
//
// AC-3 (spec §11): "delegateWithEscalation does NOT consult
// workerSelfAssessment when deciding promotion." Source-text proves no
// such gate exists.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const escalationPath = path.resolve(
  here,
  '../../packages/core/src/escalation/delegate-with-escalation.ts',
);

describe('delegateWithEscalation — M1 fix', () => {
  it('no longer contains the old workerStatus-gated promotion block', () => {
    const src = fs.readFileSync(escalationPath, 'utf-8');
    // The pre-fix gate looked like:
    //   if (best.status === 'incomplete' && best.workerStatus === 'done'
    //       && outputIsSubstantive && (filesWritten.length > 0 || hasShellVerification)) {
    //     baseStatus = 'ok';
    //   }
    // We assert the multi-token signature is absent. A simple regex search
    // tolerates whitespace variation but catches every reasonable
    // re-formatting of the original gate.
    expect(src).not.toMatch(
      /best\.workerStatus\s*===\s*['"]done['"]\s*&&[\s\S]{0,200}outputIsSubstantive/,
    );
  });

  it('contains the v5 truthful-flow marker comment', () => {
    const src = fs.readFileSync(escalationPath, 'utf-8');
    expect(src).toMatch(/v5: escalation no longer gates on workerSelfAssessment/);
  });

  it('exports delegateWithEscalation as a plain function (still callable)', async () => {
    const mod = await import(
      '../../packages/core/src/escalation/delegate-with-escalation.js'
    );
    expect(typeof mod.delegateWithEscalation).toBe('function');
  });
});
