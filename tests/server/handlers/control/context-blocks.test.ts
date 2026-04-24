// tests/server/handlers/control/context-blocks.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startTestServerWithAgents } from '../../../helpers/test-server-with-agents.js';

/**
 * Returns a canonical (symlink-resolved) temp directory path.
 * On macOS, mkdtempSync may return /var/... while realpathSync gives /private/var/...
 * The server's cwd-validator always canonicalizes via realpathSync, so the registry
 * key will be the canonical path.
 */
function makeTmpCwd(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'mmagent-ctx-block-test-')));
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

  it('returns 413 payload_too_large when content exceeds maxContextBlockBytes', async () => {
    const s = await startTestServerWithAgents();
    // Artificially lower the limit by patching the config in the registry
    // We can't inject custom config limits through startTestServerWithAgents directly,
    // so we test via a block that exceeds the default 524288-byte cap
    // by crafting a block just over the limit.
    // Since the default is 512KB, we use an alternate approach:
    // Use startTestServerWithAgents with no overrides and test the server's default
    // by using a known content that's actually oversized.
    //
    // For a reliable test, we inject the size check directly via the handler's deps.
    // Since we can't easily override the limit, we test the server default path instead
    // by using our own inline server with a small limit.
    const cwd = makeTmpCwd();
    try {
      // Default limit is 524288 (512KB) — test a block that exceeds this
      const oversized = 'a'.repeat(524_289); // 524289 bytes > 524288 byte limit
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: oversized }),
      });
      expect(res.status).toBe(413);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('payload_too_large');
    } finally {
      await s.stop();
    }
  });

  it('returns 409 cap_exhausted when project is at block cap', async () => {
    const s = await startTestServerWithAgents();
    const cwd = makeTmpCwd();
    try {
      // Fill to the default cap of 32 blocks using direct registry access
      // to avoid 32 HTTP round trips. We inject them directly via the store.
      //
      // First: trigger project creation via one real HTTP request
      await createBlock(s.url, s.token, cwd, 'first-real-block');
      const pc = s.projectRegistry.get(cwd)!;

      // Then fill the remaining 31 slots directly
      for (let i = 0; i < 31; i++) {
        pc.contextBlocks.register(`filler-block-${i}`);
      }
      // Now the store has 32 blocks (at cap)
      expect(pc.contextBlocks.size).toBe(32);

      // Next POST should fail with 409 cap_exhausted
      const res = await fetch(`${s.url}/context-blocks?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: {
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

  it('returns 400 missing_cwd when cwd query param is absent', async () => {
    const s = await startTestServerWithAgents();
    try {
      const res = await fetch(`${s.url}/context-blocks`, {
        method: 'POST',
        headers: {
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
        headers: { Authorization: `Bearer ${s.token}` },
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
        headers: { Authorization: `Bearer ${s.token}` },
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
        headers: { Authorization: `Bearer ${s.token}` },
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
        headers: { Authorization: `Bearer ${s.token}` },
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
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const json = await res.json() as { error: { code: string } };
      expect(json.error.code).toBe('not_found');
    } finally {
      await s.stop();
    }
  });
});
