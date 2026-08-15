// tests/server/handlers/control/context-blocks.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestServerWithAgents, TEST_CONTEXT_BLOCK_CAP } from '../../../helpers/test-server-with-agents.js';

/**
 * Returns a canonical (symlink-resolved) temp directory path.
 * On macOS, mkdtempSync may return /var/... while realpathSync gives /private/var/...
 * The server's cwd-validator always canonicalizes via realpathSync, so the registry
 * key will be the canonical path.
 */
function makeTmpCwd(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'mma-ctx-block-test-')));
}

async function createBlock(
  serverUrl: string,
  token: string,
  cwd: string,
  content: string,
): Promise<{ id: string }> {
  const res = await fetch(`${serverUrl}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
    method: 'POST',
    headers: {
      "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const j = await res.json();
    throw new Error(`createBlock failed: ${JSON.stringify(j)}`);
  }
  return res.json() as Promise<{ id: string }>;
}

describe('POST /context-blocks', () => {
  it('returns 201 with block id on valid request', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'hello world context' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json() as { id: string };
      expect(typeof json.id).toBe('string');
      expect(json.id.length).toBeGreaterThan(0);
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when content is missing', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ notContent: 'oops' }),
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });

  it('returns 400 invalid_request when content is empty string', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: '' }),
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('invalid_request');
    } finally {
      await s.stop();
    }
  });

  /**
   * The cap enforced must be the CONFIGURED one.
   *
   * This used to post 524_289 bytes against the default 524_288 limit, under six lines of
   * comment explaining that the helper could not inject a custom limit ("we test the server
   * default path instead"). Asserting the default cannot distinguish an enforced config value
   * from a hardcoded constant — and the helper's limitation was a shallow spread that dropped
   * `auth.tokenFile` along with the rest of the server block, now fixed.
   *
   * A 1KB configured cap with a 2KB body is rejected only if the config value is the one in
   * force, and the second case proves the same body is accepted under the default — so the
   * cap is being READ, not merely present.
   */
  it('returns 413 payload_too_large at the CONFIGURED maxContextBlockBytes', async () => {
    const s = await startTestServerWithAgents({ server: { limits: { maxContextBlockBytes: 1024 } } });
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'a'.repeat(2048) }),
      });
      expect(res.status).toBe(413);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('payload_too_large');
    } finally {
      await s.stop();
    }
  });

  it('accepts that same body under the default cap', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'a'.repeat(2048) }),
      });
      expect(res.status).not.toBe(413);
    } finally {
      await s.stop();
    }
  });

  it('returns 409 cap_exhausted when project is at block cap', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // Fill to the cap using direct registry access rather than one HTTP round trip per block.
      //
      // The cap here is the TEST SERVER's (`TEST_CONTEXT_BLOCK_CAP`), not a default — the
      // production default is 500, and this comment used to call 32 "the default cap", which
      // would send anyone debugging a real cap_exhausted to the wrong number. Taking it from the
      // helper is also what makes the case meaningful: a hardcoded 32 on both sides would pass
      // whether or not the handler reads the configured value.
      //
      // First: trigger project creation via one real HTTP request
      await createBlock(s.url, s.token, cwd, 'first-real-block');
      const pc = s.projectRegistry.get(cwd)!;

      // Then fill the remaining slots directly
      for (let i = 0; i < TEST_CONTEXT_BLOCK_CAP - 1; i++) {
        pc.contextBlocks.register(`filler-block-${i}`);
      }
      expect(pc.contextBlocks.size).toBe(TEST_CONTEXT_BLOCK_CAP);

      // Next POST should fail with 409 cap_exhausted
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'overflow-block' }),
      });
      expect(res.status).toBe(409);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('cap_exhausted');
    } finally {
      await s.stop();
    }
  });

  it('honors a per-block ttlMs (regression: handler previously dropped the validated field)', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // Block with a 1ms TTL — must expire almost immediately.
      const shortRes = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'ephemeral', ttlMs: 1 }),
      });
      expect(shortRes.status).toBe(201);
      const { id: shortId } = await shortRes.json() as { id: string };

      // Control block with no ttlMs → the store default (24h) applies.
      const { id: longId } = await createBlock(s.url, s.token, cwd, 'persistent');

      // Wait well past the 1ms TTL.
      await new Promise((r) => setTimeout(r, 25));

      const pc = s.projectRegistry.get(cwd)!;
      // With ttlMs honored, the short block is expired/gone; the default-TTL one survives.
      expect(pc.contextBlocks.get(shortId)).toBeUndefined();
      expect(pc.contextBlocks.get(longId)).toBe('persistent');
    } finally {
      await s.stop();
    }
  });

  it('returns 400 missing_cwd when cwd query param is absent', async () => {
    const s = await startTestServerWithAgents();
    try {
      const res = await fetch(`${s.url}/context-blocks`, {
        method: 'POST',
        headers: {
          "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code",
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: 'no cwd' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await s.stop();
    }
  });
});

describe('DELETE /context-blocks/:id', () => {
  it('returns 200 ok:true on successful delete', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const { id } = await createBlock(s.url, s.token, cwd, 'to be deleted');

      const res = await fetch(`${s.url}/context-blocks/${id}?cwd=${encodeURIComponent(cwd)}`, {
        method: 'DELETE',
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { ok: boolean };
      expect(json.ok).toBe(true);
    } finally {
      await s.stop();
    }
  });

  it('returns 404 not_found for unknown block id', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // Create a block so the project exists
      await createBlock(s.url, s.token, cwd, 'existing block');

      const unknownId = randomUUID();
      const res = await fetch(`${s.url}/context-blocks/${unknownId}?cwd=${encodeURIComponent(cwd)}`, {
        method: 'DELETE',
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });

  it('returns 404 not_found when trying to delete a block from a different project cwd', async () => {
    const s = await startTestServerWithAgents();
    const cwd1 = makeTmpCwd();
    const cwd2 = makeTmpCwd();
    try {
      // Create a block under cwd1
      const { id } = await createBlock(s.url, s.token, cwd1, 'block in cwd1');

      // Try to delete it using cwd2 — should get 404 (isolation)
      const res = await fetch(`${s.url}/context-blocks/${id}?cwd=${encodeURIComponent(cwd2)}`, {
        method: 'DELETE',
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });

  it('returns 409 pinned when block is in use by an active batch', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // Create a block via HTTP (this also creates the project context)
      const { id } = await createBlock(s.url, s.token, cwd, 'pinned block');

      // After the HTTP request, the project context exists in the registry
      const pc = s.projectRegistry.get(cwd)!;
      expect(pc).toBeDefined();

      // Pin the block manually (normally done by asyncDispatch via contextBlockStore)
      pc.contextBlocks.pin(id);

      const res = await fetch(`${s.url}/context-blocks/${id}?cwd=${encodeURIComponent(cwd)}`, {
        method: 'DELETE',
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(409);
      const json = await res.json() as { error: { code: string; details: { refcount: number } } };
      expect(json.error.code).toBe('pinned');
      expect(json.error.details.refcount).toBe(1);
    } finally {
      await s.stop();
    }
  });

  it('returns 404 when project has no blocks yet (project not created)', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      const unknownId = randomUUID();
      // cwd project doesn't exist yet (no prior request) — should get 404
      const res = await fetch(`${s.url}/context-blocks/${unknownId}?cwd=${encodeURIComponent(cwd)}`, {
        method: 'DELETE',
        headers: { "X-MMA-Main-Model": "claude-opus-4-7", "X-MMA-Client": "claude-code", Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });
});
