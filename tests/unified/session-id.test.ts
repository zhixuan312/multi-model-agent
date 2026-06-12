import { describe, it, expect } from 'vitest';

describe('Session.getSessionId contract', () => {
  it('returns null before any send', () => {
    const mockSession = {
      send: async () => ({} as any),
      close: async () => {},
      getSessionId: () => null as string | null,
    };
    expect(mockSession.getSessionId()).toBeNull();
  });

  it('returns string after simulated send', () => {
    const mockSession = {
      send: async () => ({} as any),
      close: async () => {},
      getSessionId: () => 'sess-abc-123',
    };
    expect(mockSession.getSessionId()).toBe('sess-abc-123');
  });
});
