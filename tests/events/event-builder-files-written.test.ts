import { describe, it, expect } from 'vitest';
import { buildTaskCompletedEvent } from '../../packages/core/src/events/event-builder.js';

describe('event-builder filesWrittenCount sourcing', () => {
  it('uses ctx.realFilesChanged for filesWrittenCount, ignoring runResult.filesChanged', () => {
    const event = buildTaskCompletedEvent({
      route: 'delegate',
      taskSpec: { filePaths: [] },
      runResult: { filesChanged: ['/wrong.ts'] },     // worker self-report (wrong)
      realFilesChanged: ['/right1.ts', '/right2.ts'], // git diff (right)
      client: 'claude-code',
      mainModel: 'claude-opus-4-7',
    } as any);
    expect(event.filesWrittenCount).toBe(2);
  });
});