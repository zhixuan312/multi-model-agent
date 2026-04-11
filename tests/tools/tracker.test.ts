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

  it('tracks listed directories separately from reads and writes', () => {
    const tracker = new FileTracker();
    tracker.trackDirectoryList('/tmp/dir-a');
    tracker.trackDirectoryList('/tmp/dir-b');
    tracker.trackRead('/tmp/file.txt');

    expect(tracker.getDirectoriesListed()).toEqual(['/tmp/dir-a', '/tmp/dir-b']);
    expect(tracker.getReads()).toEqual(['/tmp/file.txt']);
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

  it('deduplicates directory listings independently', () => {
    const tracker = new FileTracker();
    tracker.trackDirectoryList('/tmp/dir');
    tracker.trackDirectoryList('/tmp/dir');

    expect(tracker.getDirectoriesListed()).toEqual(['/tmp/dir']);
  });

  it('a single file may appear in both reads and writes', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackWrite('/tmp/foo.ts');

    expect(tracker.getReads()).toEqual(['/tmp/foo.ts']);
    expect(tracker.getWrites()).toEqual(['/tmp/foo.ts']);
  });

  it('a path can be tracked as both a read and a listed directory', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo');
    tracker.trackDirectoryList('/tmp/foo');

    expect(tracker.getReads()).toEqual(['/tmp/foo']);
    expect(tracker.getDirectoriesListed()).toEqual(['/tmp/foo']);
  });

  it('getDirectoriesListed returns a defensive copy and defaults to empty', () => {
    const tracker = new FileTracker();
    expect(tracker.getDirectoriesListed()).toEqual([]);

    tracker.trackDirectoryList('/tmp/a');
    const snapshot = tracker.getDirectoriesListed();
    snapshot.push('/tmp/mutated');

    expect(tracker.getDirectoriesListed()).toEqual(['/tmp/a']);
  });

  it('reset clears reads, writes, and tool calls', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackDirectoryList('/tmp/dir');
    tracker.trackWrite('/tmp/bar.ts');
    tracker.trackToolCall('grep(src/, "foo")');
    tracker.reset();

    expect(tracker.getReads()).toEqual([]);
    expect(tracker.getDirectoriesListed()).toEqual([]);
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
