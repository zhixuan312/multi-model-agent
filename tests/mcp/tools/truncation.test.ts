// tests/mcp/tools/truncation.test.ts
import { truncateResults } from '../../../packages/mcp/src/tools/truncation.js';

describe('truncateResults', () => {
  it('does not truncate when under threshold', () => {
    const results = [
      { status: 'ok', output: 'short', filesWritten: [] },
      { status: 'ok', output: 'also short', filesWritten: [] },
    ];
    const truncated = truncateResults(results as any, 'batch-1', 65_000);
    expect(truncated[0].output).toBe('short');
    expect(truncated[1].output).toBe('also short');
  });

  it('truncates proportionally when over threshold', () => {
    const longOutput = 'x'.repeat(40_000);
    const results = [
      { status: 'ok', output: longOutput, filesWritten: [] },
      { status: 'ok', output: longOutput, filesWritten: [] },
    ];
    const truncated = truncateResults(results as any, 'batch-1', 65_000);
    // Combined original = 80_000, threshold = 65_000
    // Each should be truncated to roughly half the budget
    expect(truncated[0].output.length).toBeLessThan(40_000);
    expect(truncated[1].output.length).toBeLessThan(40_000);
    expect(truncated[0].output).toContain('[Output truncated');
    expect(truncated[0].output).toContain('taskIndex: 0');
    expect(truncated[1].output).toContain('taskIndex: 1');
  });

  it('redistributes surplus from short outputs', () => {
    const results = [
      { status: 'ok', output: 'tiny', filesWritten: [] },           // 4 chars
      { status: 'ok', output: 'x'.repeat(70_000), filesWritten: [] }, // 70K chars
    ];
    const truncated = truncateResults(results as any, 'batch-1', 65_000);
    // Short output untouched, long output gets most of the budget
    expect(truncated[0].output).toBe('tiny');
    expect(truncated[1].output.length).toBeGreaterThan(30_000); // gets surplus from task 0
    expect(truncated[1].output).toContain('[Output truncated');
  });

  it('preserves status and filesWritten', () => {
    const results = [
      { status: 'ok', output: 'x'.repeat(70_000), filesWritten: ['foo.ts'], error: undefined },
    ];
    const truncated = truncateResults(results as any, 'batch-1', 65_000);
    expect(truncated[0].status).toBe('ok');
    expect(truncated[0].filesWritten).toEqual(['foo.ts']);
  });
});
