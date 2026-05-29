import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TerminalStatusDeriver } from '../../packages/core/src/reporting/terminal-status-deriver.js';
import type { TerminalInputs, TerminalDecision } from '../../packages/core/src/reporting/terminal-status-deriver.js';

const golden = JSON.parse(
  readFileSync('tests/contract/goldens/terminal-status-truth-table.json', 'utf8'),
) as { input: TerminalInputs; output: TerminalDecision }[];

describe('TerminalStatusDeriver truth table contract', () => {
  it('input → output matches truth table', () => {
    const d = new TerminalStatusDeriver();
    for (const { input, output } of golden) {
      expect(d.derive(input)).toEqual(output);
    }
  });
});
