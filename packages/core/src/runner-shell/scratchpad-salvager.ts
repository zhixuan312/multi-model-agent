import type { TextScratchpad } from '../tools/scratchpad.js';

export interface SalvageInput {
  scratchpad: TextScratchpad;
  reason: string;
  provider?: string;
  model?: string;
  turnsUsed?: number;
}

export interface SalvageResult {
  output: string;
  empty: boolean;
  source: 'latest' | 'longest' | 'diagnostic';
  diagnostic: string;
}

export class ScratchpadSalvager {
  salvage(input: SalvageInput): SalvageResult {
    const { scratchpad, reason, provider, model, turnsUsed } = input;

    const latest = scratchpad.latest();
    if (latest) {
      return {
        output: latest,
        empty: false,
        source: 'latest',
        diagnostic: this._diagnostic(reason, provider, model, turnsUsed, 'latest'),
      };
    }

    const longest = scratchpad.longest();
    if (longest) {
      return {
        output: longest,
        empty: false,
        source: 'longest',
        diagnostic: this._diagnostic(reason, provider, model, turnsUsed, 'longest'),
      };
    }

    const diag = this._diagnostic(reason, provider, model, turnsUsed, 'diagnostic');
    return {
      output: diag,
      empty: true,
      source: 'diagnostic',
      diagnostic: diag,
    };
  }

  private _diagnostic(
    reason: string,
    provider?: string,
    model?: string,
    turnsUsed?: number,
    source?: string,
  ): string {
    const parts: string[] = ['[ScratchpadSalvager] agent terminated without a clean final answer'];
    if (provider) parts.push(`provider=${provider}`);
    if (model) parts.push(`model=${model}`);
    parts.push(`reason=${reason}`);
    if (turnsUsed !== undefined) parts.push(`turns=${turnsUsed}`);
    if (source) parts.push(`salvageSource=${source}`);
    return parts.join(' ');
  }
}
