import { describe, it, expect } from 'vitest';
import { InMemoryContextBlockStore } from '../../packages/core/src/stores/context-block-tool.js';
import { expandContextBlocks } from '../../packages/core/src/stores/expand-context-blocks.js';
import { renderTerminalReportMarkdown } from '../../packages/core/src/reporting/terminal-report-markdown.js';

describe('terminal block delta round-trip', () => {
  it('round-1 report markdown reaches a round-2 prompt byte-for-byte', () => {
    const store = new InMemoryContextBlockStore();
    const markdown = renderTerminalReportMarkdown({
      route: 'audit', status: 'done_with_concerns',
      headline: { prefix: 'audit: 1 task', stageLabel: 'terminal', stageIndex: 3, stageTotal: 3, toolWrites: 0, toolTotal: 0 },
      findings: [{ id: 'F1', severity: 'high', category: 'coherence', claim: 'round-1 issue', evidence: 'e', suggestion: 's' }],
    } as any);
    const { id } = store.register(markdown, { id: 'terminal-b1-0' });

    const task = { id: 't', prompt: 'Re-audit and confirm F1 is resolved', contextBlockIds: [id] } as any;
    const expanded = expandContextBlocks(task, store);

    expect(expanded.prompt).toContain(markdown);
    expect(expanded.prompt).toContain('round-1 issue');
    expect(expanded.contextBlockIds).toBeUndefined();
  });

  it('a missing/evicted id throws ContextBlockNotFoundError (expired, recoverable)', () => {
    const store = new InMemoryContextBlockStore();
    const task = { id: 't', prompt: 'x', contextBlockIds: ['terminal-gone-0'] } as any;
    expect(() => expandContextBlocks(task, store)).toThrow(/unknown or expired/i);
  });
});
