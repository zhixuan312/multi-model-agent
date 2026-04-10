import { describe, it, expect } from 'vitest';
import { FileTracker } from '../../packages/core/src/tools/tracker.js';

describe('FileTracker', () => {
  it('tracks written files', () => {
    const tracker = new FileTracker();
    tracker.trackWrite('/tmp/foo.ts');
    tracker.trackWrite('/tmp/bar.ts');

    expect(tracker.getFiles()).toEqual(['/tmp/bar.ts', '/tmp/foo.ts']);
  });

  it('deduplicates files', () => {
    const tracker = new FileTracker();
    tracker.trackWrite('/tmp/foo.ts');
    tracker.trackWrite('/tmp/foo.ts');

    expect(tracker.getFiles()).toEqual(['/tmp/foo.ts']);
  });

  it('resets tracking', () => {
    const tracker = new FileTracker();
    tracker.trackWrite('/tmp/foo.ts');
    tracker.reset();

    expect(tracker.getFiles()).toEqual([]);
  });
});
