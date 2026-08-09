import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('deliverable-agnostic engine release sweep', () => {
  it('has no retired lifecycle or classification terms in generic production assets', () => {
    // `judge` is scanned as the retired CONTRACT METHOD VALUE only — never as a bare word.
    // The journal skills legitimately use "judge" as an English verb (journal_record/implement.md,
    // journal_recall/implement.md, journal/adapters/journal-adapter.ts "retrieve-then-judge");
    // those are out of scope and must not fail this sweep.
    const result = spawnSync('rg', ['-n', "kindConfirmation|methodProfile|done-with-unmet-signal|'judge'|\"judge\"|method:\\s*judge|post-delivery action", 'packages', 'DIRECTION.md', 'GUIDELINES.md', 'README.md', 'docs'], { encoding: 'utf8' });
    // `rigor` is scanned ONLY inside the contract-validation files, because the Errors bullet
    // retires rigor as CONTRACT INHERITANCE while the Behavior bullet keeps it as a legitimate
    // caller-facing interface default. A repo-wide scan would wrongly reject the permitted use.
    const rigorScan = spawnSync('rg', ['-n', '\\brigor\\b', 'packages/core/src/unified/deliverable-contract.ts', 'packages/server/src/application/deliverable-contract-validator.ts'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(rigorScan.status).toBe(1);
  });
});