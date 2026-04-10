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

  it('reset clears both reads and writes', () => {
    const tracker = new FileTracker();
    tracker.trackRead('/tmp/foo.ts');
    tracker.trackWrite('/tmp/bar.ts');
    tracker.reset();

    expect(tracker.getReads()).toEqual([]);
    expect(tracker.getWrites()).toEqual([]);
  });
});
