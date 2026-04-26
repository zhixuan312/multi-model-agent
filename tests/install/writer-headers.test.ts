import { describe, it, expect } from 'vitest';
import { notifySkillInstalled } from '../../packages/server/src/install/notify.js';

interface FakeFetch {
  fetch: typeof globalThis.fetch;
  headers(): Record<string, string> | null;
}

function fakeFetch(): FakeFetch {
  let capturedHeaders: Record<string, string> | null = null;
  const fetch = async (_url: string, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? null;
    return new Response('{}', { status: 200 });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    headers: () => capturedHeaders,
  };
}

describe('install writers emit correct X-MMA-Client header on outbound requests', () => {
  it('claude-code writer sends X-MMA-Client: claude-code', async () => {
    const fake = fakeFetch();
    notifySkillInstalled({ skillId: 'mma-delegate', client: 'claude-code', fetch: fake.fetch });
    await new Promise((r) => setTimeout(r, 10));
    const h = fake.headers();
    expect(h).toBeTruthy();
    expect(h!['X-MMA-Client']).toBe('claude-code');
  });

  it('cursor writer sends X-MMA-Client: cursor', async () => {
    const fake = fakeFetch();
    notifySkillInstalled({ skillId: 'mma-audit', client: 'cursor', fetch: fake.fetch });
    await new Promise((r) => setTimeout(r, 10));
    const h = fake.headers();
    expect(h).toBeTruthy();
    expect(h!['X-MMA-Client']).toBe('cursor');
  });

  it('codex writer sends X-MMA-Client: codex-cli', async () => {
    const fake = fakeFetch();
    notifySkillInstalled({ skillId: 'mma-review', client: 'codex', fetch: fake.fetch });
    await new Promise((r) => setTimeout(r, 10));
    const h = fake.headers();
    expect(h).toBeTruthy();
    expect(h!['X-MMA-Client']).toBe('codex-cli');
  });

  it('gemini writer sends X-MMA-Client: gemini-cli', async () => {
    const fake = fakeFetch();
    notifySkillInstalled({ skillId: 'mma-verify', client: 'gemini', fetch: fake.fetch });
    await new Promise((r) => setTimeout(r, 10));
    const h = fake.headers();
    expect(h).toBeTruthy();
    expect(h!['X-MMA-Client']).toBe('gemini-cli');
  });
});
