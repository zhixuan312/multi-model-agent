import { describe, it, expect } from 'vitest';
import { FileTracker } from '../../packages/core/src/tools/tracker.js';

describe('FileTracker', () => {
  it('tracks written files', () => {
    const tracker = new FileTracker();
    tracker.trackWrite('/tmp/foo.ts');
    tracker.trackWrite('/tmp/bar.ts');

    expect(tracker.getWrites()).toEqual(['/tmp/bar.ts', '/tmp/foo.ts']);
    expect(tracker.getReads()).toEqual([]);
  });

  it('tracks read files separately from writes', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackRead('/tmp/bar.ts');
    tracker.trackWrite('/tmp/baz.ts');

    expect(tracker.getReads()).toEqual(['/tmp/bar.ts', '/tmp/foo.ts']);
    expect(tracker.getWrites()).toEqual(['/tmp/baz.ts']);
  });

  it('deduplicates reads and writes independently', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackWrite('/tmp/bar.ts');
    tracker.trackWrite('/tmp/bar.ts');

    expect(tracker.getReads()).toEqual(['/tmp/foo.ts']);
    expect(tracker.getWrites()).toEqual(['/tmp/bar.ts']);
  });

  it('a single file may appear in both reads and writes', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackWrite('/tmp/foo.ts');

    expect(tracker.getReads()).toEqual(['/tmp/foo.ts']);
    expect(tracker.getWrites()).toEqual(['/tmp/foo.ts']);
  });

  it('reset clears reads, writes, and tool calls', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackWrite('/tmp/bar.ts');
    tracker.trackToolCall('grep(src/, "foo")');
    tracker.reset();

    expect(tracker.getReads()).toEqual([]);
    expect(tracker.getWrites()).toEqual([]);
    expect(tracker.getToolCalls()).toEqual([]);
  });

  it('trackToolCall preserves insertion order and allows duplicates', () => {
    const tracker = new FileTracker();
    tracker.trackToolCall('readFile(a.ts)');
    tracker.trackToolCall('grep(src/, "foo")');
    tracker.trackToolCall('readFile(a.ts)');

    expect(tracker.getToolCalls()).toEqual([
      'readFile(a.ts)',
      'grep(src/, "foo")',
      'readFile(a.ts)',
    ]);
  });

  it('getToolCalls returns a defensive copy', () => {
    const tracker = new FileTracker();
    tracker.trackToolCall('a');
    const snapshot = tracker.getToolCalls();
    snapshot.push('mutated');
    expect(tracker.getToolCalls()).toEqual(['a']);
  });

  it('fires the optional onToolCall callback synchronously for every trackToolCall (Task 9)', () => {
    const observed: string[] = [];
    const tracker = new FileTracker((summary) => {
      observed.push(summary);
    });
    tracker.trackToolCall('readFile(a.ts)');
    tracker.trackToolCall('grep(src/, "foo")');

    // Callback fires in call order, once per invocation, BEFORE returning.
    expect(observed).toEqual(['readFile(a.ts)', 'grep(src/, "foo")']);
    // And the internal list is still populated normally.
    expect(tracker.getToolCalls()).toEqual(['readFile(a.ts)', 'grep(src/, "foo")']);
  });

  it('still works when no onToolCall callback is supplied (back-compat)', () => {
    const tracker = new FileTracker();
    expect(() => tracker.trackToolCall('readFile(a.ts)')).not.toThrow();
    expect(tracker.getToolCalls()).toEqual(['readFile(a.ts)']);
  });
});
